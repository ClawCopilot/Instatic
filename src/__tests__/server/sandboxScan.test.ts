/**
 * Unit tests for the sandbox literal scanner (`sandboxScan.ts`).
 *
 * The scanner is the install-time / build-time gate that rejects plugin
 * bundles referencing Node/Bun runtime APIs. After the bridged-module
 * change, `crypto` / `net` / `util` imports ARE allowed (the bootstrap
 * installs host shims and `esmShim.ts` rewrites the imports), but every
 * other `node:` / `bun:` literal and bare Node module name must still be
 * rejected.
 *
 * These tests lock both sides of that contract: the allowlist and the
 * denylist, so neither side drifts silently.
 */
import { describe, expect, it } from 'bun:test'
import { findSandboxLiterals, assertSandboxSafe } from '../../core/plugins/sandboxScan'

describe('findSandboxLiterals — forbidden literals', () => {
  it('flags require( calls', () => {
    expect(findSandboxLiterals(`const fs = require('fs')`)).toContainEqual({ literal: 'require(' })
  })

  it('flags process.binding', () => {
    expect(findSandboxLiterals(`process.binding('fs')`)).toContainEqual({ literal: 'process.binding' })
  })

  it('flags globalThis.process.env', () => {
    expect(findSandboxLiterals(`globalThis.process.env.SECRET`)).toContainEqual({ literal: 'globalThis.process.env' })
  })

  it('flags node:fs literals (single-quoted)', () => {
    const findings = findSandboxLiterals(`import { readFile } from 'node:fs';`)
    expect(findings.some((f) => f.literal === "'node:fs'")).toBe(true)
  })

  it('flags node:fs literals (double-quoted)', () => {
    const findings = findSandboxLiterals(`import { readFile } from "node:fs";`)
    expect(findings.some((f) => f.literal === '"node:fs"')).toBe(true)
  })

  it('flags node:child_process literals', () => {
    const findings = findSandboxLiterals(`import { spawn } from 'node:child_process';`)
    expect(findings.some((f) => f.literal === "'node:child_process'")).toBe(true)
  })

  it('flags bun: imports', () => {
    const findings = findSandboxLiterals(`import { serve } from 'bun:api';`)
    expect(findings.some((f) => f.literal === "'bun:api'")).toBe(true)
  })

  it('flags bare Node module names (fs)', () => {
    const findings = findSandboxLiterals(`import { readFile } from 'fs';`)
    expect(findings.some((f) => f.literal === "'fs'")).toBe(true)
  })

  it('flags bare Node module names (child_process)', () => {
    const findings = findSandboxLiterals(`from "child_process"`)
    expect(findings.some((f) => f.literal === '"child_process"')).toBe(true)
  })

  it('does NOT flag require( inside a string literal that is not a call', () => {
    // The scanner is textual — `require(` anywhere counts. This test locks
    // the current behavior so a future refactor to AST-based scanning is
    // a deliberate, reviewed change.
    const findings = findSandboxLiterals(`const msg = "don't use require() in sandbox"`)
    expect(findings.some((f) => f.literal === 'require(')).toBe(true)
  })
})

describe('findSandboxLiterals — bridged modules (allowed)', () => {
  it('allows node:crypto', () => {
    expect(findSandboxLiterals(`import { createHash } from 'node:crypto';`)).toEqual([])
  })

  it('allows node:net', () => {
    expect(findSandboxLiterals(`import { createConnection } from 'node:net';`)).toEqual([])
  })

  it('allows node:util', () => {
    expect(findSandboxLiterals(`import { promisify } from 'node:util';`)).toEqual([])
  })

  it('allows bare "crypto"', () => {
    expect(findSandboxLiterals(`import { createHash } from "crypto";`)).toEqual([])
  })

  it('allows bare "net"', () => {
    expect(findSandboxLiterals(`import { connect } from "net";`)).toEqual([])
  })

  it('allows bare "util"', () => {
    expect(findSandboxLiterals(`import { inspect } from "util";`)).toEqual([])
  })

  it('allows a bundle mixing bridged and safe code', () => {
    const src = [
      `import { createHash, randomBytes } from "crypto";`,
      `import { promisify } from "node:util";`,
      `export const h = createHash('sha256').update('x').digest('hex');`,
    ].join('\n')
    expect(findSandboxLiterals(src)).toEqual([])
  })
})

describe('assertSandboxSafe', () => {
  it('throws for forbidden literals', () => {
    expect(() => assertSandboxSafe(`require('fs')`, 'test-plugin')).toThrow(/forbidden literals/)
  })

  it('does NOT throw for bridged crypto imports', () => {
    expect(() => assertSandboxSafe(`import { createHash } from "crypto";`, 'test-plugin')).not.toThrow()
  })

  it('does NOT throw for bridged node:util imports', () => {
    expect(() => assertSandboxSafe(`import { promisify } from "node:util";`, 'test-plugin')).not.toThrow()
  })

  it('throws for node:fs', () => {
    expect(() => assertSandboxSafe(`import { readFile } from "node:fs";`, 'test-plugin')).toThrow(/node:fs/)
  })

  it('error message mentions the bridged modules', () => {
    try {
      assertSandboxSafe(`import { readFile } from "node:fs";`, 'test-plugin')
      expect.fail('should have thrown')
    } catch (e) {
      expect((e as Error).message).toContain('crypto')
      expect((e as Error).message).toContain('bridged')
    }
  })
})
