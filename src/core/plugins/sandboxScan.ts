/**
 * Static analysis scan for sandbox-incompatible literals.
 *
 * Plugin server entrypoints and module packs run inside a QuickJS-WASM
 * sandbox that has NO access to Node/Bun runtime APIs. If a bundle ships
 * with `import 'node:fs'`, `Bun.spawn`, `require()`, etc., the sandbox
 * fails at activation time with a low-level loader error.
 *
 * This scan runs at two points:
 *  - Build time, inside `instatic-plugin build` — catches author mistakes early
 *    with an actionable error message.
 *  - Install time, inside `readPluginPackage` — defense-in-depth against
 *    bundles produced outside our CLI (raw zip uploads, packages signed
 *    elsewhere).
 *
 * The check is purely textual. False positives are possible (a plugin that
 * happens to ship the literal string `'node:fs'` inside a constant), but
 * are rare; the error message lists the offender so authors can rename.
 *
 * Bridged modules: `node:crypto`, `node:net`, `node:util` (and their
 * unprefixed aliases) ARE allowed through because the bootstrap installs
 * host-bridged shims (`__module_crypto` / `__module_net` / `__module_util`)
 * and `esmShim.ts` rewrites their `import` statements to reference those
 * globals. The bridged set is shared with `esmShim.ts` via
 * `BRIDGED_MODULE_GLOBALS` so the two never disagree.
 */

import { BRIDGED_MODULE_GLOBALS } from '../../../server/plugins/quickjs/esmShim'

/**
 * Forbidden literal substrings that indicate sandbox-incompatible code.
 * `node:` / `bun:` literals are checked separately against the bridged-module
 * allowlist, so they are intentionally absent from this flat array.
 */
const FORBIDDEN_SANDBOX_LITERALS = [
  'require(',
  'process.binding',
  'globalThis.process.env',
] as const

/**
 * Node built-in module specifiers that the sandbox bridges to host-provided
 * shims. A `node:`-prefixed or bare specifier matching this set is permitted;
 * every other `node:` / `bun:` literal is rejected.
 *
 * Derived from `BRIDGED_MODULE_GLOBALS` so the scan and the shim stay in sync.
 */
const BRIDGED_SPECIFIERS: ReadonlySet<string> = new Set(BRIDGED_MODULE_GLOBALS.keys())

interface SandboxScanFinding {
  literal: string
}

/** Scan a single bundle's text for forbidden literals. */
export function findSandboxLiterals(source: string): SandboxScanFinding[] {
  const findings: SandboxScanFinding[] = []

  for (const literal of FORBIDDEN_SANDBOX_LITERALS) {
    if (source.includes(literal)) findings.push({ literal })
  }

  // Reject any `node:` / `bun:` literal EXCEPT those referencing bridged
  // modules. We scan for both single- and double-quoted forms, and for the
  // bare-specifier forms (`"crypto"`, `"net"`, `"util"`) that Bun emits when
  // `target: 'bun'` leaves them external.
  for (const quote of ["'", '"'] as const) {
    const nodePrefixed = new RegExp(
      quote + 'node:([a-z0-9_./-]+)' + quote,
      'g',
    )
    let m: RegExpExecArray | null
    while ((m = nodePrefixed.exec(source)) !== null) {
      const specifier = 'node:' + m[1]
      if (!BRIDGED_SPECIFIERS.has(specifier)) {
        findings.push({ literal: `${quote}node:${m[1]}${quote}` })
      }
    }

    const bunPrefixed = new RegExp(quote + 'bun:([a-z0-9_./-]+)' + quote, 'g')
    while ((m = bunPrefixed.exec(source)) !== null) {
      // Bun has no bridged modules — every `bun:` literal is forbidden.
      findings.push({ literal: `${quote}bun:${m[1]}${quote}` })
    }

    // Bare-specifier check: `"fs"`, `"child_process"`, etc. Only the three
    // bridged bare names (`crypto`, `net`, `util`) are allowed; anything else
    // that looks like a bare Node module literal is flagged. We intentionally
    // keep this conservative — false positives on a string constant that
    // happens to look like a module name are rare and the error message
    // names the offender so authors can rename.
    const bareNodeModule = new RegExp(
      quote + '(fs|child_process|os|path|stream|http|https|tls|zlib|dns|dgram|cluster|readline|repl|tty|vm|worker_threads|perf_hooks|assert|async_hooks|inspector|process|v8|trace_events)' + quote,
      'g',
    )
    while ((m = bareNodeModule.exec(source)) !== null) {
      findings.push({ literal: `${quote}${m[1]}${quote}` })
    }
  }

  return findings
}

/**
 * Throw a descriptive error if any forbidden literal is found. Used by the
 * SDK CLI's `bundleEntrypoint` and by the install-time package validator.
 */
export function assertSandboxSafe(source: string, sourceLabel: string): void {
  const findings = findSandboxLiterals(source)
  if (findings.length === 0) return
  const offenders = findings.map((f) => f.literal).join(', ')
  throw new Error(
    `Plugin sandbox: bundle for "${sourceLabel}" references forbidden literals: ${offenders}.\n` +
    `Plugins run inside a QuickJS-WASM sandbox with no access to Node/Bun runtime APIs. Use the SDK ` +
    `(api.cms.storage.*, api.cms.hooks.*, api.cms.routes.*) for I/O instead. The modules crypto, net, ` +
    `and util are bridged via host shims and may be imported normally.`,
  )
}
