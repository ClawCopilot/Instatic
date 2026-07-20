import { describe, expect, it } from 'bun:test'
import { join } from 'node:path'
import { platform } from 'node:os'

const ROOT = join(import.meta.dir, '../../..')

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes)
}

describe('Circular dependencies', () => {
  // madge hangs on Windows due to its dependency graph traversal;
  // skip on Windows and rely on CI (Linux) for this check.
  const skipOnWindows = platform() === 'win32' ? it.skip : it

  skipOnWindows('keeps the tsconfig-aware source graph cycle-free', () => {
    const result = Bun.spawnSync({
      cmd: [
        process.execPath,
        'x',
        'madge',
        '--circular',
        '--ts-config',
        'tsconfig.json',
        '--extensions',
        'ts,tsx',
        'src',
        'server',
      ],
      cwd: ROOT,
      stdout: 'pipe',
      stderr: 'pipe',
    })

    const output = `${decode(result.stdout)}${decode(result.stderr)}`
    if (result.exitCode !== 0) {
      throw new Error(
        `Circular dependencies found. Run the same command locally for the full graph:\n` +
          `bun x madge --circular --ts-config tsconfig.json --extensions ts,tsx src server\n\n` +
          output,
      )
    }

    expect(output).toContain('No circular dependency found')
  }, 15000)
})
