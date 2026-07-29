import { describe, expect, it } from 'bun:test'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '../../..')

describe('Circular dependencies', () => {
  it('keeps the tsconfig-aware source graph cycle-free', () => {
    const result = Bun.spawnSync({
      cmd: [
        process.execPath,
        'x',
        'depcruise',
        '--config',
        join(ROOT, '.dependency-cruiser.cjs'),
        '--output-type',
        'err-long',
        'src',
        'server',
      ],
      cwd: ROOT,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const output = `${result.stdout.toString()}${result.stderr.toString()}`

    expect(
      result.exitCode,
      output,
    ).toBe(0)
  }, 30_000)
})
