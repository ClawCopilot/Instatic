import * as os from 'node:os'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { createDbClient, type DbClient } from '../../../server/db'
import { runMigrations } from '../../../server/db/runMigrations'

export interface TestDb {
  db: DbClient
  cleanup: () => Promise<void>
}

/**
 * Create a fresh DB for tests. Defaults to an isolated temp-file SQLite DB
 * with all migrations applied. Each call produces a unique, independent DB.
 *
 * Set `DB=postgres TEST_POSTGRES_URL=postgres://...` to run against a real
 * Postgres instance instead. The helper supports that mode at the type level;
 * connection-pool teardown is left to process exit until DbClient grows a
 * close() method.
 *
 * @example
 * const { db, cleanup } = await createTestDb()
 * try {
 *   // use db
 * } finally {
 *   await cleanup()
 * }
 */
export async function createTestDb(): Promise<TestDb> {
  if (process.env['DB'] === 'postgres') {
    const url = process.env['TEST_POSTGRES_URL']
    if (!url) throw new Error('TEST_POSTGRES_URL must be set when DB=postgres')
    const { db, migrations } = createDbClient(url)
    await runMigrations(db, migrations)
    return {
      db,
      cleanup: async () => {
        // Test-helper cleanup: no-op for the opt-in PG test mode.
        // DbClient does not expose a close() method; connection-pool teardown
        // is handled at process exit.
      },
    }
  }

  // Default: SQLite at a unique per-test temp file. createDbClient creates the
  // parent directory automatically via mkdirSync, so no pre-creation needed.
  const tmpFile = path.join(os.tmpdir(), `cms-test-${crypto.randomUUID()}`, 'test.db')
  const { db, migrations } = createDbClient(`sqlite:${tmpFile}`)
  await runMigrations(db, migrations)

  return {
    db,
    cleanup: async () => {
      // bun:sqlite doesn't expose a close() method. On macOS/Linux the file
      // can be deleted while the handle is open. On Windows, the file lock
      // prevents deletion entirely — swallow EBUSY/EPERM and rely on the OS
      // temp-directory cleanup.
      //
      // Use a 3-second AbortSignal so fs.rm never hangs indefinitely on
      // Windows when the SQLite handle is still held (bun:sqlite has no
      // close() method).
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 3000)
      try {
        await fs.rm(path.dirname(tmpFile), { recursive: true, force: true, signal: controller.signal })
      } catch {
        // Windows: SQLite file still locked by bun:sqlite handle, or abort
        // timeout reached. Harmless — the OS cleans temp dirs on reboot.
      } finally {
        clearTimeout(timer)
      }
    },
  }
}
