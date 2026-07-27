/**
 * ESM → global handoff shim — the ONE rewriter both QuickJS sandboxes share.
 *
 * QuickJS has no module loader, so a plugin bundle (or a hand-authored
 * single-file fixture) must be flattened from ESM into a plain script that
 * hands its exports to a `globalThis.<globalName>` the bootstrap reads. Two
 * sandboxes consume this:
 *
 *   - the full-plugin worker (`pluginWorker.ts`), global `__plugin_exports` —
 *     wants the whole exports object, because plugin lifecycle hooks are named
 *     exports (`export function activate(api) { … }`);
 *   - the canvas module-pack VM (`modulePackVm.ts`), global `__module_pack` —
 *     wants only the default export value (an array of module definitions, or
 *     a factory function returning one) assigned directly.
 *
 * Export forms handled — the union of every shape Bun's bundler and plugin
 * authors emit (previously split across two diverging private copies):
 *
 *   - `export default <expr>`               — direct default export
 *   - `export default function/class …`     — default declaration
 *   - `export function/const/let <name> …`  — named declarations
 *   - `export { a as default, b, c }`       — re-export / mixed default+named
 *     blocks (Bun emits this for default re-export facades)
 *
 * Import forms handled — bridge modules the sandbox cannot natively resolve
 * to host-provided shims exposed by the bootstrap:
 *
 *   - `import { createHash, … } from "crypto"|"node:crypto"`
 *     → `const { createHash, … } = globalThis.__module_crypto;`
 *   - `import { createConnection, … } from "net"|"node:net"`
 *     → `const { createConnection, … } = globalThis.__module_net;`
 *   - `import { promisify, … } from "util"|"node:util"`
 *     → `const { promisify, … } = globalThis.__module_util;`
 *   - `import * as ns from "crypto"` → `const ns = globalThis.__module_crypto;`
 *   - `import crypto from "crypto"` → `const crypto = globalThis.__module_crypto;`
 *   - `import "crypto"` (side-effect import) → removed
 *
 * `unwrapDefault` selects the global's SHAPE — the single legitimate
 * difference between the two bootstraps. Everything else (which forms are
 * recognised) is identical, so a bundle that loads as a plugin also loads as a
 * module pack.
 */

/**
 * Modules the bootstrap provides host-bridged shims for. The map is shared
 * with `sandboxScan.ts` (the install-time gate) so the two never disagree
 * about what is allowed through.
 */
export const BRIDGED_MODULE_GLOBALS: ReadonlyMap<string, string> = new Map([
  ['crypto', '__module_crypto'],
  ['node:crypto', '__module_crypto'],
  ['net', '__module_net'],
  ['node:net', '__module_net'],
  ['util', '__module_util'],
  ['node:util', '__module_util'],
])

/**
 * Rewrite a single `import` statement line to a `const`-destructure
 * (or alias) referencing the bridged global. Returns `null` when the
 * specifier is NOT a bridged module — the caller then leaves the line
 * untouched so QuickJS surfaces a clear SyntaxError for genuinely unknown
 * modules.
 *
 * Shapes recognised (anchored at line start, tolerating leading whitespace):
 *   import { a, b as c } from "spec";   → const { a, b: c } = __module_X;
 *   import * as ns from "spec";         → const ns = __module_X;
 *   import def from "spec";             → const def = __module_X;
 *   import def, { a } from "spec";      → const def = __module_X; const { a } = __module_X;
 *   import "spec";                      → (removed — side-effect only)
 */
function rewriteImportLine(
  line: string,
): { replacement: string; bridged: true } | null {
  // Capture leading indentation so the replacement aligns with the source.
  const indentMatch = line.match(/^[ \t]*/)
  const indent = indentMatch ? indentMatch[0] : ''

  // import "spec";  /  import "spec"
  const bareMatch = line.match(/^([ \t]*)import\s+(['"])([^'"]+)\2\s*;?\s*$/)
  if (bareMatch) {
    const specifier = bareMatch[3]
    if (BRIDGED_MODULE_GLOBALS.has(specifier)) {
      return { replacement: '', bridged: true }
    }
    return null
  }

  // import def from "spec";
  const defaultOnly = line.match(/^([ \t]*)import\s+([A-Za-z_$][\w$]*)\s+from\s+(['"])([^'"]+)\3\s*;?\s*$/)
  if (defaultOnly) {
    const specifier = defaultOnly[4]
    const globalName = BRIDGED_MODULE_GLOBALS.get(specifier)
    if (!globalName) return null
    return {
      replacement: `${indent}const ${defaultOnly[2]} = globalThis.${globalName};`,
      bridged: true,
    }
  }

  // import * as ns from "spec";
  const namespaceMatch = line.match(/^([ \t]*)import\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s+(['"])([^'"]+)\3\s*;?\s*$/)
  if (namespaceMatch) {
    const specifier = namespaceMatch[4]
    const globalName = BRIDGED_MODULE_GLOBALS.get(specifier)
    if (!globalName) return null
    return {
      replacement: `${indent}const ${namespaceMatch[2]} = globalThis.${globalName};`,
      bridged: true,
    }
  }

  // import def, { a, b as c } from "spec";   (combined default + named)
  const combinedMatch = line.match(
    /^([ \t]*)import\s+([A-Za-z_$][\w$]*)\s*,\s*\{([^}]*)\}\s+from\s+(['"])([^'"]+)\4\s*;?\s*$/,
  )
  if (combinedMatch) {
    const specifier = combinedMatch[5]
    const globalName = BRIDGED_MODULE_GLOBALS.get(specifier)
    if (!globalName) return null
    const defaultBinding = combinedMatch[2]
    const namedDestructure = rewriteNamedImports(combinedMatch[3], indent, globalName)
    return {
      replacement: `${indent}const ${defaultBinding} = globalThis.${globalName}; ${namedDestructure}`,
      bridged: true,
    }
  }

  // import { a, b as c } from "spec";
  const namedMatch = line.match(/^([ \t]*)import\s+\{([^}]*)\}\s+from\s+(['"])([^'"]+)\3\s*;?\s*$/)
  if (namedMatch) {
    const specifier = namedMatch[4]
    const globalName = BRIDGED_MODULE_GLOBALS.get(specifier)
    if (!globalName) return null
    return {
      replacement: rewriteNamedImports(namedMatch[2], indent, globalName),
      bridged: true,
    }
  }

  return null
}

/**
 * Convert an ESM named-imports clause (`a, b as c, d`) to a `const`
 * destructure against the bridged global (`const { a, b: c, d } = __module_X;`).
 * ESM `as` maps to destructure renaming (`b as c` → `b: c`).
 */
function rewriteNamedImports(
  clause: string,
  indent: string,
  globalName: string,
): string {
  const entries: string[] = []
  for (const rawEntry of clause.split(',')) {
    const entry = rawEntry.trim()
    if (!entry) continue
    const asMatch = entry.match(/^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/)
    if (asMatch) {
      entries.push(`${asMatch[1]}: ${asMatch[2]}`)
      continue
    }
    const bareMatch = entry.match(/^([A-Za-z_$][\w$]*)$/)
    if (bareMatch) {
      entries.push(bareMatch[1])
    }
  }
  if (entries.length === 0) return ''
  return `${indent}const { ${entries.join(', ')} } = globalThis.${globalName};`
}

export function wrapEsmAsGlobal(
  source: string,
  globalName: string,
  options: { unwrapDefault?: boolean } = {},
): string {
  // If the source already targets the bridge's global, it came pre-flattened
  // from the SDK bundler — pass through untouched.
  if (source.includes(globalName)) return source

  // First pass — rewrite `import` statements that reference bridged modules
  // (crypto / net / util) into `const` bindings against the host-provided
  // shims. Non-bridged imports are left untouched; QuickJS will then throw a
  // SyntaxError naming the unknown specifier, which is far more actionable
  // than a silent miscompile.
  let transformed = source.replace(
    /^[ \t]*import\s+.*$/gm,
    (line) => {
      const result = rewriteImportLine(line)
      return result ? result.replacement : line
    },
  )

  // Second pass — rewrite `export` forms. Anchored regexes match `export` at
  // the start of a (possibly indented) line. Each form becomes an assignment
  // on a local `__exports` object; the global handoff at the end picks shape.
  transformed = transformed
    .replace(
      /^([ \t]*)export\s+(async\s+)?function\s+([A-Za-z_$][\w$]*)/gm,
      '$1__exports.$3 = $2function $3',
    )
    .replace(
      /^([ \t]*)export\s+const\s+([A-Za-z_$][\w$]*)\s*=/gm,
      '$1__exports.$2 =',
    )
    .replace(
      /^([ \t]*)export\s+let\s+([A-Za-z_$][\w$]*)\s*=/gm,
      '$1__exports.$2 =',
    )
    .replace(
      /^([ \t]*)export\s+default\s+/gm,
      '$1__exports.default = ',
    )

  // Rewrite `export { foo as default[, bar, …] }` blocks into one assignment
  // per entry: `as default` → `__exports.default`, bare names → same-name
  // properties. Anything unparseable falls through; the QuickJS eval then
  // surfaces a clear SyntaxError to the caller.
  transformed = transformed.replace(
    /^([ \t]*)export\s*\{([^}]*)\}\s*;?/gm,
    (_match, indent: string, body: string) => {
      const assigns: string[] = []
      for (const rawEntry of body.split(',')) {
        const entry = rawEntry.trim()
        if (!entry) continue
        const asMatch = entry.match(/^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/)
        if (asMatch) {
          assigns.push(`${indent}__exports.${asMatch[2]} = ${asMatch[1]};`)
          continue
        }
        const bareMatch = entry.match(/^([A-Za-z_$][\w$]*)$/)
        if (bareMatch) {
          assigns.push(`${indent}__exports.${bareMatch[1]} = ${bareMatch[1]};`)
        }
      }
      return assigns.join('\n')
    },
  )

  const handoff = options.unwrapDefault
    ? `globalThis.${globalName} = __exports.default;`
    : `globalThis.${globalName} = __exports;`

  // The prelude shares the first physical line with the source's first line
  // (and the handoff comes after it) so wrapping adds ZERO line offset —
  // QuickJS stack traces from the wrapped eval (filename `plugin:<id>` /
  // `module-pack:<id>`) report the same line numbers as the bundle the
  // author shipped.
  return `;(function () { const __exports = {}; ${transformed}\n${handoff}\n})();\n`
}
