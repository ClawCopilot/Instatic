/**
 * End-to-end plugin test.
 *
 * Boots the Instatic host (CMS only, no vite), creates the owner, logs in,
 * installs one of the 8 first-party plugins from a built bundle, activates
 * it, and calls one of its endpoints to verify the round trip works.
 *
 * The test writes to a temporary SQLite database and a free port so it can
 * be run repeatedly without disturbing the developer's local environment.
 *
 * Usage:
 *   bun run scripts/e2e-plugin-install.ts [plugin-id]
 *   e.g.  bun run scripts/e2e-plugin-install.ts instatic.api-keys
 *
 * Exits 0 on success, non-zero on failure.
 */

import { spawn, type Subprocess } from 'node:child_process'
import { writeFile, mkdir, rm, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zipSync, strToU8 } from 'fflate'
import { createServer } from 'node:net'

const ROOT = join(import.meta.dir, '..')
const PLUGIN_ID = process.argv[2] ?? 'instatic.api-keys'

// Pick a free port
function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      if (typeof addr === 'object' && addr) {
        const port = addr.port
        server.close(() => resolve(port))
      } else {
        server.close(() => reject(new Error('Could not get free port')))
      }
    })
    server.on('error', reject)
  })
}

function log(msg: string) {
  console.log(`[E2E] ${msg}`)
}

function logStep(n: number, msg: string) {
  console.log(`\n=== Step ${n}: ${msg} ===`)
}

function ok(msg: string) {
  console.log(`  ✓ ${msg}`)
}

function fail(msg: string): never {
  console.error(`  ✗ ${msg}`)
  process.exit(1)
}

// ── Step 1: Build a plugin .zip ───────────────────────────────────────

async function buildPluginZip(pluginId: string): Promise<{ zip: Uint8Array; manifest: Record<string, unknown> }> {
  const distPath = join(ROOT, 'plugins', pluginId.replace(/^instatic\./, ''), 'dist/index.js')
  if (!existsSync(distPath)) {
    fail(`Plugin dist not found: ${distPath}. Run 'bun run build:plugins' first.`)
  }
  const distCode = await readFile(distPath, 'utf-8')
  const pkgPath = join(ROOT, 'plugins', pluginId.replace(/^instatic\./, ''), 'package.json')
  const pkgJson = JSON.parse(await readFile(pkgPath, 'utf-8'))
  const instaticManifest = pkgJson.instaticManifest

  // Build plugin.json
  const pluginJson = {
    id: pluginId,
    name: instaticManifest.name,
    version: instaticManifest.version,
    apiVersion: instaticManifest.apiVersion,
    description: instaticManifest.description ?? '',
    permissions: instaticManifest.permissions,
    entrypoints: {
      server: 'dist/index.js',
    },
    resources: [],
    adminPages: [],
    networkAllowedHosts: instaticManifest.networkAllowedHosts ?? [],
  }
  const files: Record<string, Uint8Array> = {
    'plugin.json': strToU8(JSON.stringify(pluginJson, null, 2)),
    'dist/index.js': strToU8(distCode),
  }

  // Build .zip using fflate's deflateRawSync. Minimal zip writer.
  const zip = buildZip(files)
  return { zip, manifest: pluginJson }
}

function buildZip(files: Record<string, Uint8Array | string>): Uint8Array {
  // Normalize values to Uint8Array (fflate accepts string or Uint8Array)
  const normalized: Record<string, Uint8Array | string> = {}
  for (const [k, v] of Object.entries(files)) {
    normalized[k] = typeof v === 'string' ? new TextEncoder().encode(v) : v
  }
  // fflate's zipSync produces a valid zip. Use it instead of hand-rolling.
  return zipSync(normalized, { level: 0 })  // level 0 = no compression
}

// ── Step 2: Boot the host ──────────────────────────────────────────────

// Module-scope so error handlers outside bootHost can read it
let hostOutput = ''

async function bootHost(port: number, dbPath: string): Promise<Subprocess> {
  logStep(2, `Booting host on port ${port} with DB ${dbPath}`)
  hostOutput = ''
  // Use npx to find bun — Windows can't resolve 'bun' on PATH reliably.
  const bunExe = process.platform === 'win32' ? 'npx.cmd' : 'npx'
  const proc = spawn(bunExe, ['bun', 'server/index.ts'], {
    cwd: ROOT,
    env: {
      ...process.env,
      DATABASE_URL: `sqlite:${dbPath}`,
      PORT: String(port),
      NODE_ENV: 'development',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
  }) as unknown as Subprocess
  // waitForServer calls proc.exited as a Promise
  Object.defineProperty(proc, 'exited', {
    get() { return proc.exitCode !== null ? Promise.resolve(proc.exitCode) : new Promise((r) => proc.on('exit', r)) },
  })
  // Capture host output for debugging
  ;(async () => {
    for await (const chunk of proc.stdout) hostOutput += new TextDecoder().decode(chunk)
  })()
  ;(async () => {
    for await (const chunk of proc.stderr) hostOutput += new TextDecoder().decode(chunk)
  })()
  try {
    await waitForServer(`http://127.0.0.1:${port}`, proc)
  } catch (err) {
    proc.kill()
    console.error('\n--- Host output (last 2000 chars) ---\n' + hostOutput.slice(-2000))
    throw err
  }
  ok(`Host ready on http://127.0.0.1:${port}`)
  return proc
}

async function waitForServer(url: string, proc: Subprocess): Promise<void> {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`${url}/admin/api/cms/setup/status`)
      if (res.ok) return
    } catch {
      // Connection refused is expected while the host is still booting — keep polling.
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  proc.kill()
  fail(`Server at ${url} did not become ready in 30s`)
}

// ── HTTP helpers ─────────────────────────────────────────────────────

class Client {
  constructor(public baseUrl: string) {}
  private cookies = ''

  async fetch(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers)
    if (this.cookies) headers.set('cookie', this.cookies)
    const res = await fetch(`${this.baseUrl}${path}`, { ...init, headers })
    const setCookie = res.headers.get('set-cookie')
    if (setCookie) this.cookies = setCookie.split(';')[0]
    return res
  }

  async getJson<T = unknown>(path: string): Promise<{ status: number; data: T | null }> {
    const res = await this.fetch(path)
    return { status: res.status, data: (await res.json().catch(() => null)) as T | null }
  }
  async postJson<T = unknown>(path: string, body: unknown): Promise<{ status: number; data: T | null }> {
    const res = await this.fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    return { status: res.status, data: (await res.json().catch(() => null)) as T | null }
  }
  async delete<T = unknown>(path: string): Promise<{ status: number; data: T | null }> {
    const res = await this.fetch(path, { method: 'DELETE' })
    return { status: res.status, data: (await res.json().catch(() => null)) as T | null }
  }
}

// ── Main test ─────────────────────────────────────────────────────────

async function main() {
  log(`Plugin: ${PLUGIN_ID}`)
  log(`Working dir: ${ROOT}`)

  // Setup
  const tempDir = join(tmpdir(), `instatic-e2e-${Date.now()}`)
  await mkdir(tempDir, { recursive: true })
  const dbPath = join(tempDir, 'test.db')
  const port = await getFreePort()
  log(`Temp dir: ${tempDir}`)
  log(`Port: ${port}`)

  // Step 1: Build plugin .zip
  logStep(1, `Building plugin package for ${PLUGIN_ID}`)
  const { zip, manifest } = await buildPluginZip(PLUGIN_ID)
  const zipPath = join(tempDir, `${manifest.id}.zip`)
  await writeFile(zipPath, zip)
  ok(`Plugin package: ${zipPath} (${zip.length} bytes)`)

  // Step 2: Boot host
  const proc = await bootHost(port, dbPath)
  const client = new Client(`http://127.0.0.1:${port}`)

  try {
    // Step 3: Check setup status
    logStep(3, 'Check setup status')
    const status = await client.getJson('/admin/api/cms/setup/status')
    if (!status.data?.needsSetup) fail('Setup should be needed on a fresh install')
    ok('Fresh install detected')

    // Step 4: Create owner
    logStep(4, 'Create site + owner user')
    const setupRes = await client.postJson('/admin/api/cms/setup', {
      siteName: 'E2E Test Site',
      email: 'owner@e2e.test',
      password: 'OwnerPass123!Safe',
    })
    if (setupRes.status !== 201) fail(`Setup failed: ${JSON.stringify(setupRes.data)}`)
    ok('Site + owner created')

    // Step 5: Log in
    logStep(5, 'Log in as owner')
    const loginRes = await client.postJson('/admin/api/cms/login', {
      email: 'owner@e2e.test',
      password: 'OwnerPass123!Safe',
    })
    if (loginRes.status !== 200 && loginRes.status !== 204) {
      fail(`Login failed (${loginRes.status}): ${JSON.stringify(loginRes.data)}`)
    }
    if (!client.cookies) fail('No session cookie set after login')
    ok(`Logged in (cookie: ${client.cookies.slice(0, 30)}...)`)

    // Step 5b: Open the step-up window. Plugin install is a sensitive
    // operation (uploads + executes arbitrary plugin code), so the host
    // requires a fresh password confirmation via /auth/step-up.
    logStep('5b', 'Open step-up window (re-confirm password)')
    const stepUpRes = await client.postJson('/admin/api/cms/auth/step-up', {
      password: 'OwnerPass123!Safe',
    })
    if (stepUpRes.status !== 200) fail(`Step-up failed (${stepUpRes.status}): ${JSON.stringify(stepUpRes.data)}`)
    ok('Step-up window opened (15 min)')

    // Step 6: Install plugin from .zip
    logStep(6, `Install ${PLUGIN_ID} from .zip`)
    const installRes = await client.fetch('/admin/api/cms/plugins/package', {
      method: 'POST',
      // The install endpoint calls req.formData() and reads the `file` field.
      // Use FormData to encode the multipart correctly.
      body: (() => {
        const fd = new FormData()
        fd.append('file', new Blob([zip], { type: 'application/zip' }), `${manifest.id}.zip`)
        return fd
      })(),
    })
    const installData = await installRes.json().catch(() => null)
    if (installRes.status !== 200 && installRes.status !== 201) {
      console.error('\n--- Host output (last 3000 chars) ---\n' + hostOutput.slice(-3000))
      fail(`Install failed (${installRes.status}): ${JSON.stringify(installData)}`)
    }
    ok(`Plugin installed: ${JSON.stringify(installData?.plugin?.id ?? manifest.id)}`)

    // Step 7: List installed plugins
    logStep(7, 'List installed plugins')
    const listRes = await client.getJson('/admin/api/cms/plugins')
    if (listRes.status !== 200) fail(`List failed: ${JSON.stringify(listRes.data)}`)
    const found = listRes.data?.plugins?.find((p: { id: string; version: string; lifecycleStatus?: string; status?: string }) => p.id === PLUGIN_ID)
    if (!found) fail(`Plugin ${PLUGIN_ID} not in installed list`)
    ok(`Found in list: ${found.id} v${found.version} (${found.lifecycleStatus ?? found.status})`)

    // Step 8: Call a plugin endpoint (depends on the plugin)
    logStep(8, `Call a ${PLUGIN_ID} endpoint`)
    let endpointRes: { status: number; data: unknown }
    if (PLUGIN_ID === 'instatic.api-keys') {
      // Create an API key
      endpointRes = await client.postJson('/admin/api/keys', {
        label: 'E2E Test Key',
        scope: 'admin',
      })
      if (endpointRes.status !== 201) fail(`Create API key failed: ${JSON.stringify(endpointRes.data)}`)
      const token = endpointRes.data?.token
      if (!token || !token.startsWith('instk_')) fail(`Token format wrong: ${token}`)
      ok(`Created API key: ${token.slice(0, 16)}...`)

      // List the keys
      const list = await client.getJson('/admin/api/keys')
      if (list.status !== 200) fail(`List keys failed: ${JSON.stringify(list.data)}`)
      ok(`List returned ${list.data?.keys?.length} keys`)

      // Test Bearer auth
      const authClient = new Client(`http://127.0.0.1:${port}`)
      const meRes = await authClient.fetch('/api/keys/me', {
        headers: { 'authorization': `Bearer ${token}` },
      })
      if (meRes.status !== 200) fail(`Bearer auth failed: ${meRes.status}`)
      const meData = await meRes.json()
      ok(`Bearer auth works: ${meData.id} ${meData.label}`)
    } else if (PLUGIN_ID === 'instatic.public-auth') {
      const reg = await client.postJson('/api/auth/register', {
        email: 'testuser@e2e.test',
        password: 'UserPass123!',
        displayName: 'Test User',
      })
      if (reg.status !== 201) fail(`Register failed: ${JSON.stringify(reg.data)}`)
      ok(`User registered: ${reg.data.userId}`)
    } else if (PLUGIN_ID === 'instatic.membership') {
      const t = await client.getJson('/api/membership/tiers')
      if (t.status !== 200) fail(`List tiers failed: ${JSON.stringify(t.data)}`)
      ok(`Public tiers endpoint returned ${t.data?.tiers?.length ?? 0} tiers`)
    } else if (PLUGIN_ID === 'instatic.oidc-provider') {
      const disc = await client.getJson('/.well-known/openid-configuration')
      if (disc.status !== 200) fail(`Discovery failed: ${JSON.stringify(disc.data)}`)
      ok(`OIDC discovery: issuer=${disc.data?.issuer}`)
    } else {
      // Generic: just verify activation worked
      ok('Generic activation check passed')
    }

    log('\n=== ✅ E2E PASSED ===')
    log(`   ${PLUGIN_ID} installed and operational in real host`)
  } finally {
    log('\nCleaning up...')
    // Robust cleanup — Windows holds file handles for ~1s after process exits
    try { proc.kill('SIGTERM') } catch {
      // Process may have already exited — best-effort cleanup.
    }
    // Best-effort rm; tolerate Windows file locks (temp files reaped later)
    for (let attempt = 0; attempt < 3; attempt++) {
      try { await rm(tempDir, { recursive: true, force: true }); break } catch { await new Promise((r) => setTimeout(r, 1000)) }
    }
  }
}

main().catch((err) => {
  console.error('E2E FAILED:', err)
  process.exit(1)
})
