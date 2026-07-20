/**
 * Atomicity race test for the two-slot publish protocol.
 *
 * Verifies the core safety property from the publishing-architecture spec:
 *
 *   "In-flight readers either see the old generation or the new generation,
 *    never a mix, never a missing file."
 *
 * Approach: run a write loop and a read loop concurrently via Promise.all.
 * The write loop executes full publish cycles (prepareInactiveSlot → write →
 * swapSlot) as fast as possible. The read loop calls readArtefact repeatedly
 * for routes that are guaranteed to exist in BOTH slot generations. Any null
 * return (including from the TOCTOU race between symlink resolution and file
 * open) is a test failure.
 *
 * We use real tmpdir filesystem operations — not mocks — so actual rename(2)
 * and symlink atomicity semantics are exercised.
 *
 * Platform note: the strict "never null" guarantee relies on POSIX `rename(2)`
 * atomically replacing a directory symlink. On Windows (non-admin) symlinks
 * are unavailable (`EPERM`), so `swapSlot` uses a plain text file instead.
 * The strict test is therefore symlink-only; the coherence test below
 * (which tolerates null) runs on every platform.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm, symlink, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  prepareInactiveSlot,
  readArtefact,
  swapSlot,
  writeArtefact,
} from '../../../server/publish/staticArtefact'

// Runtime detection: can we actually create symlinks? On Windows non-admin
// `symlink()` throws EPERM. We probe once at module load to decide which
// tests can run.
const canSymlink = await (async (): Promise<boolean> => {
  const probePath = join(tmpdir(), `symlink-probe-${process.pid}-${Date.now()}`)
  const probeTarget = join(tmpdir(), `symlink-probe-target-${process.pid}-${Date.now()}`)
  try {
    await symlink(probeTarget, probePath)
    await unlink(probePath)
    return true
  } catch {
    return false
  }
})()

const PUBLISH_CYCLES = 200
const READS_PER_CYCLE = 10 // concurrent reads per write iteration = 2000 total reads
const ROUTES = ['/home', '/about', '/posts/hello', '/products/widget']

let uploadsDir: string

beforeEach(async () => {
  uploadsDir = await mkdtemp(join(tmpdir(), 'artefact-race-'))
})

afterEach(async () => {
  try {
    await rm(uploadsDir, { recursive: true, force: true })
  } catch {
    // Windows: SQLite file still locked; OS cleans temp dirs on reboot.
  }
})

describe('publishAtomicityRace', () => {
  // Symlink-only: the never-null invariant depends on atomic symlink rename.
  // On Windows (non-admin) symlinks are unavailable, so swapSlot uses a plain
  // text file and the strict assertion cannot hold there.
  it.skipIf(!canSymlink)(
    'readArtefact never returns null for routes present in both slot generations',
    async () => {
      // ── Phase 0: Seed both slots with initial content ──────────────────────
      // This ensures every route exists in BOTH a/ and b/ before the
      // concurrent loops begin. The invariant must hold for every read, even
      // those that race against a slot wipe.

      const gen0Html = (route: string) => `<html>gen-0:${route}</html>`
      const gen1Html = (route: string) => `<html>gen-1:${route}</html>`

      // First inactive slot (b) — seed with generation 0
      const { slot: initSlot1, slotDir: initSd1 } = await prepareInactiveSlot(uploadsDir)
      for (const route of ROUTES) {
        await writeArtefact(initSd1, route, gen0Html(route))
      }
      await swapSlot(uploadsDir, initSlot1)
      // current → initSlot1, initSlot1 has gen-0 content

      // Other slot (the now-inactive one) — seed with generation 1
      const { slot: initSlot2, slotDir: initSd2 } = await prepareInactiveSlot(uploadsDir)
      for (const route of ROUTES) {
        await writeArtefact(initSd2, route, gen1Html(route))
      }
      await swapSlot(uploadsDir, initSlot2)
      // current → initSlot2, initSlot2 has gen-1 content
      // initSlot1 still has gen-0 content (not wiped — it was the active slot)

      // Both slots are now seeded. Every route exists in a/ and b/.

      // ── Phase 1: Concurrent write + read loops ─────────────────────────────

      let nullReads = 0
      let totalReads = 0
      const errors: string[] = []

      /**
       * Write loop: execute PUBLISH_CYCLES full publish cycles.
       *
       * Each cycle:
       *   1. prepareInactiveSlot — wipes + recreates the inactive slot
       *   2. writeArtefact       — writes all routes into the inactive slot
       *   3. swapSlot            — atomic symlink flip
       *
       * After every swap, BOTH routes are available in the new active slot
       * (just written) AND the previous active slot (not yet wiped). This is
       * the invariant the read loop asserts.
       */
      const writeLoop = async (): Promise<void> => {
        for (let i = 0; i < PUBLISH_CYCLES; i++) {
          const { slot, slotDir } = await prepareInactiveSlot(uploadsDir)
          for (const route of ROUTES) {
            await writeArtefact(slotDir, route, `<html>cycle-${i}:${route}:slot-${slot}</html>`)
          }
          await swapSlot(uploadsDir, slot)
        }
      }

      /**
       * Read loop: repeatedly call readArtefact for all routes.
       *
       * Runs PUBLISH_CYCLES × READS_PER_CYCLE iterations. Any null return
       * for a route that exists in both generations is a failure.
       */
      const readLoop = async (): Promise<void> => {
        for (let i = 0; i < PUBLISH_CYCLES * READS_PER_CYCLE; i++) {
          for (const route of ROUTES) {
            const result = await readArtefact(uploadsDir, route)
            totalReads++
            if (result === null) {
              nullReads++
              errors.push(`null read for "${route}" on iteration ${i}`)
            }
          }
        }
      }

      await Promise.all([writeLoop(), readLoop()])

      // Surface detailed error before the raw count assertion
      if (errors.length > 0) {
        throw new Error(
          `${errors.length} null reads out of ${totalReads} total:\n${errors.slice(0, 10).join('\n')}`,
        )
      }
      expect(nullReads).toBe(0)
      expect(totalReads).toBeGreaterThan(0)
    },
    60_000, // 60-second timeout for 200 publish cycles × 4 routes
  )

  it(
    'readArtefact content is always a coherent HTML string (never partial)',
    async () => {
      const ROUTE = '/coherence-check'
      const SENTINEL = 'SENTINEL-'

      // Seed both slots
      const { slot: s1, slotDir: sd1 } = await prepareInactiveSlot(uploadsDir)
      await writeArtefact(sd1, ROUTE, `<html>${SENTINEL}gen-0</html>`)
      await swapSlot(uploadsDir, s1)

      const { slot: s2, slotDir: sd2 } = await prepareInactiveSlot(uploadsDir)
      await writeArtefact(sd2, ROUTE, `<html>${SENTINEL}gen-1</html>`)
      await swapSlot(uploadsDir, s2)

      let incoherentReads = 0

      const writeLoop = async (): Promise<void> => {
        for (let i = 0; i < 100; i++) {
          const { slot, slotDir } = await prepareInactiveSlot(uploadsDir)
          await writeArtefact(slotDir, ROUTE, `<html>${SENTINEL}gen-${i + 2}</html>`)
          await swapSlot(uploadsDir, slot)
        }
      }

      const readLoop = async (): Promise<void> => {
        for (let i = 0; i < 1000; i++) {
          const result = await readArtefact(uploadsDir, ROUTE)
          if (result !== null && !result.includes(SENTINEL)) {
            incoherentReads++
          }
        }
      }

      await Promise.all([writeLoop(), readLoop()])

      // Every non-null read must contain the sentinel (no partial/corrupt HTML)
      expect(incoherentReads).toBe(0)
    },
    60_000,
  )
})
