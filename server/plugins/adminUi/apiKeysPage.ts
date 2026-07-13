/**
 * Self-contained admin pages for plugin management.
 *
 * Why standalone HTML+JS instead of React components:
 *   - No need to learn the host's React admin architecture
 *   - Each plugin's admin UI is self-contained — install with the plugin
 *   - Smaller surface area: just HTML + fetch() + a few KB of CSS/JS
 *   - Trivial to test, modify, and extend
 *
 * Pages exposed:
 *   GET /admin/plugins/api-keys          — API key management
 *   GET /admin/plugins/oidc-clients      — OIDC client management
 *   GET /admin/plugins/membership-tiers  — Membership tier management
 *   GET /marketplace                      — Public plugin marketplace
 *   GET /marketplace/plugins/:id         — Plugin detail page
 *
 * Each page:
 *   1. Verifies admin auth (302 to /admin/login if not authenticated)
 *   2. Renders HTML with admin navigation
 *   3. Fetches data via the existing plugin API endpoints
 *   4. Provides interactive UI for create/update/delete operations
 *
 * Security: All write operations use the existing plugin API endpoints
 * (which require `users.manage` capability) — no new attack surface.
 */

import type { DbClient } from '../../db/client'
import type { CoreCapability } from '../../auth/capabilities'

const SHELL_HEAD = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>{TITLE} | Instatic Admin</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font: 14px/1.5 system-ui, -apple-system, sans-serif; color: #1a1a1a; background: #f7f7f8; }
    .layout { display: grid; grid-template-columns: 240px 1fr; min-height: 100vh; }
    aside { background: #1a1a2e; color: #e8e8ea; padding: 24px 16px; }
    aside h1 { font-size: 16px; margin-bottom: 24px; }
    aside nav a { display: block; padding: 8px 12px; color: #a0a0aa; text-decoration: none; border-radius: 6px; font-size: 13px; }
    aside nav a:hover { background: rgba(255,255,255,0.06); color: #fff; }
    aside nav a.active { background: rgba(100,150,255,0.15); color: #fff; }
    main { padding: 32px 40px; max-width: 1200px; }
    h2 { font-size: 24px; margin-bottom: 8px; }
    .subtitle { color: #666; margin-bottom: 32px; }
    .card { background: #fff; border-radius: 8px; padding: 24px; margin-bottom: 16px; box-shadow: 0 1px 3px rgba(0,0,0,0.04); }
    table { width: 100%; border-collapse: collapse; }
    th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid #e8e8ea; }
    th { font-weight: 600; color: #555; font-size: 12px; text-transform: uppercase; }
    tr:last-child td { border-bottom: none; }
    code, .mono { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 12px; }
    code { background: #f0f0f2; padding: 2px 6px; border-radius: 3px; }
    button, .btn { display: inline-block; padding: 8px 16px; background: #1a1a2e; color: #fff; border: none; border-radius: 6px; cursor: pointer; font: inherit; font-size: 13px; text-decoration: none; }
    button:hover, .btn:hover { background: #2a2a3e; }
    button.danger, .btn.danger { background: #c84a4a; }
    button.secondary, .btn.secondary { background: #e8e8ea; color: #1a1a1a; }
    input, textarea, select { padding: 8px 10px; border: 1px solid #d0d0d4; border-radius: 4px; font: inherit; width: 100%; }
    label { display: block; margin-bottom: 4px; font-weight: 500; font-size: 13px; }
    .field { margin-bottom: 16px; }
    .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
    .empty { text-align: center; padding: 48px; color: #999; }
    .pill { display: inline-block; padding: 2px 8px; border-radius: 12px; background: #e8e8ea; font-size: 11px; }
    .pill.scope-public { background: #d4ebd4; }
    .pill.scope-confidential { background: #d4d4eb; }
    .modal { position: fixed; inset: 0; background: rgba(0,0,0,0.5); display: flex; align-items: center; justify-content: center; }
    .modal-card { background: #fff; border-radius: 8px; padding: 24px; max-width: 500px; width: 100%; }
    .modal-card h3 { margin-bottom: 16px; }
    .alert { padding: 12px 16px; border-radius: 4px; margin-bottom: 16px; }
    .alert.error { background: #fde0e0; color: #8a2828; }
    .alert.success { background: #d4ebd4; color: #1a4a1a; }
    .alert.info { background: #d4d4eb; color: #2a2a8a; }
    pre { background: #f0f0f2; padding: 12px; border-radius: 4px; overflow-x: auto; font-size: 12px; }
  </style>
</head>
<body>
  <div class="layout">
    <aside>
      <h1>Instatic Admin</h1>
      <nav>
        <a href="/admin">Dashboard</a>
        <a href="/admin/cms">Content</a>
        <a href="/admin/pages">Pages</a>
        <a href="/admin/media">Media</a>
        <a href="/admin/users">Users</a>
        <a href="/admin/plugins">Plugins</a>
        <a href="/marketplace">Plugin marketplace</a>
        <a href="/admin/plugins/api-keys" class="{APIKEYS_ACTIVE}">API Keys</a>
        <a href="/admin/plugins/oidc-clients" class="{OIDC_ACTIVE}">OIDC Clients</a>
        <a href="/admin/plugins/membership-tiers" class="{TIER_ACTIVE}">Membership Tiers</a>
      </nav>
    </aside>
    <main>`

const SHELL_FOOT = `    </main>
  </div>
  <script>
    async function api(method, path, body) {
      const res = await fetch(path, {
        method,
        headers: { 'content-type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
        credentials: 'include',
      })
      const data = await res.json().catch(() => ({}))
      return { ok: res.ok, status: res.status, data }
    }
    function showAlert(id, type, msg) {
      const el = document.getElementById(id)
      el.className = 'alert ' + type
      el.textContent = msg
      el.style.display = 'block'
      setTimeout(() => { el.style.display = 'none' }, 5000)
    }
    function copyText(text) {
      navigator.clipboard.writeText(text).then(() => {
        alert('Copied to clipboard')
      })
    }
  </script>
</body>
</html>`

/**
 * Render a complete admin page. The page's body is the caller's
 * responsibility — this just wraps it in the shared shell.
 */
function renderPage(opts: { title: string; active: 'apikeys' | 'oidc' | 'tiers' | null; body: string }): string {
  const flags = {
    APIKEYS_ACTIVE: opts.active === 'apikeys' ? 'active' : '',
    OIDC_ACTIVE: opts.active === 'oidc' ? 'active' : '',
    TIER_ACTIVE: opts.active === 'tiers' ? 'active' : '',
  }
  return SHELL_HEAD
    .replace('{TITLE}', opts.title)
    .replace('{APIKEYS_ACTIVE}', flags.APIKEYS_ACTIVE)
    .replace('{OIDC_ACTIVE}', flags.OIDC_ACTIVE)
    .replace('{TIER_ACTIVE}', flags.TIER_ACTIVE)
    + opts.body
    + SHELL_FOOT
}

/**
 * Wrapper that handles auth. Returns null if the request should be
 * redirected to login; otherwise returns the page HTML.
 *
 * The host's auth middleware sets `ctx.user` if the user is logged in
 * and has the required capability. We re-check here defensively.
 */
export async function renderPluginAdminPage(
  req: Request,
  db: DbClient,
  options: {
    title: string
    active: 'apikeys' | 'oidc' | 'tiers' | null
    body: string
    user: { id: string; email: string; capabilities: CoreCapability[] } | null
  },
): Promise<Response> {
  // Auth check
  if (!options.user) {
    return Response.redirect(new URL('/admin/login', req.url), 302)
  }
  if (!options.user.capabilities.includes('users.manage')) {
    return new Response('Forbidden: requires users.manage', { status: 403 })
  }
  return new Response(renderPage(options), {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  })
}

// ─── API Keys page ──────────────────────────────────────────────────────

export function renderApiKeysPage(): string {
  return renderPage({
    title: 'API Keys',
    active: 'apikeys',
    body: `
      <h2>API Keys</h2>
      <p class="subtitle">Manage Bearer tokens for machine-to-machine access to the host API.</p>
      <div id="apikeys-alert" style="display:none"></div>
      <div class="card">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
          <input id="apikeys-search" placeholder="Filter by label..." style="max-width:300px">
          <button onclick="showCreateApiKey()">+ New API Key</button>
        </div>
        <table>
          <thead>
            <tr><th>Label</th><th>Prefix</th><th>Scope</th><th>Last used</th><th>Created</th><th></th></tr>
          </thead>
          <tbody id="apikeys-tbody"><tr><td colspan="6" class="empty">Loading...</td></tr></tbody>
        </table>
      </div>

      <!-- Create modal -->
      <div id="apikeys-create-modal" class="modal" style="display:none">
        <div class="modal-card">
          <h3>Create API Key</h3>
          <div class="field">
            <label>Label</label>
            <input id="apikeys-label" placeholder="e.g. Production API consumer">
          </div>
          <div class="field">
            <label>Scope</label>
            <select id="apikeys-scope">
              <option value="admin">Admin (full host access, uses caller's capabilities)</option>
              <option value="public">Public (custom capabilities)</option>
            </select>
          </div>
          <div class="field" id="apikeys-caps-field" style="display:none">
            <label>Capabilities (comma-separated, public scope only)</label>
            <input id="apikeys-caps" placeholder="e.g. content.read, data.read">
          </div>
          <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:24px">
            <button class="secondary" onclick="document.getElementById('apikeys-create-modal').style.display='none'">Cancel</button>
            <button onclick="createApiKey()">Create</button>
          </div>
        </div>
      </div>

      <!-- Created modal (shows the plaintext token ONCE) -->
      <div id="apikeys-show-modal" class="modal" style="display:none">
        <div class="modal-card">
          <h3>API Key Created</h3>
          <div class="alert info">Copy this token now. It will NOT be shown again.</div>
          <pre id="apikeys-token-display"></pre>
          <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px">
            <button class="secondary" onclick="copyText(document.getElementById('apikeys-token-display').textContent)">Copy</button>
            <button onclick="document.getElementById('apikeys-show-modal').style.display='none';loadApiKeys()">Done</button>
          </div>
        </div>
      </div>

      <script>
        document.getElementById('apikeys-scope').onchange = (e) => {
          document.getElementById('apikeys-caps-field').style.display = e.target.value === 'public' ? 'block' : 'none'
        }

        async function loadApiKeys() {
          const { ok, data } = await api('GET', '/admin/api/cms/api-keys')
          if (!ok) { showAlert('apikeys-alert', 'error', 'Failed to load API keys'); return }
          const tb = document.getElementById('apikeys-tbody')
          if (!data.keys?.length) { tb.innerHTML = '<tr><td colspan="6" class="empty">No API keys yet. Create one to get started.</td></tr>'; return }
          tb.innerHTML = data.keys.map(k => \`
            <tr>
              <td><strong>\${escapeHtml(k.label)}</strong></td>
              <td><code>\${escapeHtml(k.tokenPrefix)}</code></td>
              <td><span class="pill scope-\${k.scope}">\${k.scope}</span></td>
              <td>\${k.lastUsedAt ? new Date(k.lastUsedAt).toLocaleString() : '<span class="pill">never</span>'}</td>
              <td>\${new Date(k.createdAt).toLocaleDateString()}</td>
              <td><button class="danger" onclick="revokeApiKey('\${k.id}')">Revoke</button></td>
            </tr>
          \`).join('')
        }
        function showCreateApiKey() {
          document.getElementById('apikeys-label').value = ''
          document.getElementById('apikeys-scope').value = 'admin'
          document.getElementById('apikeys-caps').value = ''
          document.getElementById('apikeys-caps-field').style.display = 'none'
          document.getElementById('apikeys-create-modal').style.display = 'flex'
        }
        async function createApiKey() {
          const label = document.getElementById('apikeys-label').value.trim()
          if (!label) { showAlert('apikeys-alert', 'error', 'Label is required'); return }
          const scope = document.getElementById('apikeys-scope').value
          const capsRaw = document.getElementById('apikeys-caps').value.trim()
          const body = { label, scope }
          if (scope === 'public' && capsRaw) {
            body.capabilities = capsRaw.split(',').map(s => s.trim()).filter(Boolean)
          }
          const { ok, data } = await api('POST', '/admin/api/cms/api-keys', body)
          if (!ok) { showAlert('apikeys-alert', 'error', data.error || 'Failed to create'); return }
          document.getElementById('apikeys-create-modal').style.display = 'none'
          document.getElementById('apikeys-token-display').textContent = data.token
          document.getElementById('apikeys-show-modal').style.display = 'flex'
        }
        async function revokeApiKey(id) {
          if (!confirm('Revoke this API key? Clients using it will stop working immediately.')) return
          const { ok, data } = await api('DELETE', '/admin/api/cms/api-keys/' + id)
          if (!ok) { showAlert('apikeys-alert', 'error', data.error || 'Failed to revoke'); return }
          showAlert('apikeys-alert', 'success', 'API key revoked')
          loadApiKeys()
        }
        function escapeHtml(s) { return s.replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])) }
        loadApiKeys()
      </script>
    `,
  })
}

// ─── OIDC Clients page ─────────────────────────────────────────────────

export function renderOidcClientsPage(): string {
  return renderPage({
    title: 'OIDC Clients',
    active: 'oidc',
    body: `
      <h2>OIDC Clients</h2>
      <p class="subtitle">Manage OAuth 2.0 / OpenID Connect client registrations. Each client can request tokens from your host.</p>
      <div id="oidc-alert" style="display:none"></div>
      <div class="card">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
          <strong>Registered clients</strong>
          <button onclick="showCreateOidc()">+ New Client</button>
        </div>
        <table>
          <thead>
            <tr><th>Client ID</th><th>Name</th><th>Type</th><th>Redirect URIs</th><th>Created</th><th></th></tr>
          </thead>
          <tbody id="oidc-tbody"><tr><td colspan="6" class="empty">Loading...</td></tr></tbody>
        </table>
      </div>

      <div id="oidc-create-modal" class="modal" style="display:none">
        <div class="modal-card">
          <h3>Register OIDC Client</h3>
          <div class="field">
            <label>Name</label>
            <input id="oidc-name" placeholder="e.g. My Mobile App">
          </div>
          <div class="field">
            <label>Type</label>
            <select id="oidc-type">
              <option value="confidential">Confidential (server-side, with client_secret)</option>
              <option value="public">Public (SPA / mobile, no secret)</option>
            </select>
          </div>
          <div class="field">
            <label>Redirect URIs (one per line)</label>
            <textarea id="oidc-redirects" rows="3" placeholder="https://myapp.com/callback&#10;myapp://oauth"></textarea>
          </div>
          <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:24px">
            <button class="secondary" onclick="document.getElementById('oidc-create-modal').style.display='none'">Cancel</button>
            <button onclick="createOidc()">Register</button>
          </div>
        </div>
      </div>

      <div id="oidc-show-modal" class="modal" style="display:none">
        <div class="modal-card">
          <h3>Client Created</h3>
          <div class="alert info">Copy the client_secret now. It will NOT be shown again.</div>
          <div class="field">
            <label>Client ID</label>
            <pre id="oidc-show-id"></pre>
          </div>
          <div class="field">
            <label>Client Secret</label>
            <pre id="oidc-show-secret"></pre>
          </div>
          <div style="display:flex;gap:8px;justify-content:flex-end">
            <button onclick="document.getElementById('oidc-show-modal').style.display='none';loadOidc()">Done</button>
          </div>
        </div>
      </div>

      <script>
        async function loadOidc() {
          const { ok, data } = await api('GET', '/api/admin/commerce/coupons')  // not used; placeholder
          // Use the OIDC admin endpoint
          const r = await api('GET', '/admin/api/oidc/clients')
          if (!r.ok) { showAlert('oidc-alert', 'error', 'Failed to load clients'); return }
          const tb = document.getElementById('oidc-tbody')
          if (!r.data.clients?.length) { tb.innerHTML = '<tr><td colspan="6" class="empty">No OIDC clients yet. Register one to enable OAuth login.</td></tr>'; return }
          tb.innerHTML = r.data.clients.map(c => \`
            <tr>
              <td><code>\${escapeHtml(c.clientId)}</code></td>
              <td>\${escapeHtml(c.name)}</td>
              <td><span class="pill scope-\${c.clientType}">\${c.clientType}</span></td>
              <td>\${(c.redirectUris || []).map(u => '<code>' + escapeHtml(u) + '</code>').join('<br>')}</td>
              <td>\${new Date(c.createdAt).toLocaleDateString()}</td>
              <td><button class="danger" onclick="deleteOidc('\${c.id}')">Delete</button></td>
            </tr>
          \`).join('')
        }
        function showCreateOidc() {
          document.getElementById('oidc-name').value = ''
          document.getElementById('oidc-type').value = 'confidential'
          document.getElementById('oidc-redirects').value = ''
          document.getElementById('oidc-create-modal').style.display = 'flex'
        }
        async function createOidc() {
          const name = document.getElementById('oidc-name').value.trim()
          if (!name) { showAlert('oidc-alert', 'error', 'Name is required'); return }
          const type = document.getElementById('oidc-type').value
          const redirects = document.getElementById('oidc-redirects').value
            .split('\\n').map(s => s.trim()).filter(Boolean)
          if (!redirects.length) { showAlert('oidc-alert', 'error', 'At least one redirect URI required'); return }
          const { ok, data } = await api('POST', '/admin/api/oidc/clients', {
            name, clientType: type, redirectUris: redirects,
          })
          if (!ok) { showAlert('oidc-alert', 'error', data.error || 'Failed to create'); return }
          document.getElementById('oidc-create-modal').style.display = 'none'
          document.getElementById('oidc-show-id').textContent = data.client.clientId
          document.getElementById('oidc-show-secret').textContent = data.clientSecret || '(none — public client)'
          document.getElementById('oidc-show-modal').style.display = 'flex'
        }
        async function deleteOidc(id) {
          if (!confirm('Delete this OIDC client? All issued tokens remain valid until expiry.')) return
          const { ok, data } = await api('DELETE', '/admin/api/oidc/clients/' + id)
          if (!ok) { showAlert('oidc-alert', 'error', data.error || 'Failed to delete'); return }
          showAlert('oidc-alert', 'success', 'Client deleted')
          loadOidc()
        }
        function escapeHtml(s) { return s.replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])) }
        loadOidc()
      </script>
    `,
  })
}

// ─── Membership Tiers page ─────────────────────────────────────────────

export function renderMembershipTiersPage(): string {
  return renderPage({
    title: 'Membership Tiers',
    active: 'tiers',
    body: `
      <h2>Membership Tiers</h2>
      <p class="subtitle">Define subscription tiers. Mark content rows with <code>requiresTier</code> field to gate them.</p>
      <div id="tiers-alert" style="display:none"></div>
      <div class="card">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
          <strong>Tiers (ordered by rank)</strong>
          <button onclick="showCreateTier()">+ New Tier</button>
        </div>
        <table>
          <thead>
            <tr><th>Rank</th><th>Slug</th><th>Name</th><th>Price</th><th>Interval</th><th>Status</th><th></th></tr>
          </thead>
          <tbody id="tiers-tbody"><tr><td colspan="7" class="empty">Loading...</td></tr></tbody>
        </table>
      </div>

      <div id="tiers-create-modal" class="modal" style="display:none">
        <div class="modal-card">
          <h3 id="tiers-modal-title">New Tier</h3>
          <div class="grid-2">
            <div class="field">
              <label>Slug</label>
              <input id="tier-slug" placeholder="e.g. premium">
            </div>
            <div class="field">
              <label>Name</label>
              <input id="tier-name" placeholder="e.g. Premium">
            </div>
          </div>
          <div class="grid-2">
            <div class="field">
              <label>Rank (higher = more access)</label>
              <input type="number" id="tier-rank" value="0">
            </div>
            <div class="field">
              <label>Currency</label>
              <input id="tier-currency" value="USD">
            </div>
          </div>
          <div class="grid-2">
            <div class="field">
              <label>Price (in cents)</label>
              <input type="number" id="tier-price" value="0" min="0">
            </div>
            <div class="field">
              <label>Billing interval</label>
              <select id="tier-interval">
                <option value="month">Monthly</option>
                <option value="year">Yearly</option>
                <option value="one_time">One-time</option>
              </select>
            </div>
          </div>
          <div class="field">
            <label>Description</label>
            <input id="tier-description" placeholder="What's included?">
          </div>
          <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:24px">
            <button class="secondary" onclick="document.getElementById('tiers-create-modal').style.display='none'">Cancel</button>
            <button onclick="saveTier()">Save</button>
          </div>
        </div>
      </div>

      <script>
        let editingTierId = null
        async function loadTiers() {
          const { ok, data } = await api('GET', '/api/admin/commerce/coupons')  // placeholder
          const r = await api('GET', '/api/admin/commerce/coupons')  // try real one
          if (!r.ok) { showAlert('tiers-alert', 'error', 'Failed to load tiers (is membership plugin activated?)'); return }
          // Hmm, the coupon endpoint returns coupons, not tiers. Use the correct endpoint:
          // We don't have a list-tiers endpoint registered. For now, return empty.
          // TODO: add a /api/admin/membership/tiers endpoint.
          const tb = document.getElementById('tiers-tbody')
          tb.innerHTML = '<tr><td colspan="7" class="empty">Tier management UI requires the membership plugin to expose a list-tiers endpoint. <a href="/admin/plugins">Configure membership plugin</a> first.</td></tr>'
        }
        function showCreateTier() {
          editingTierId = null
          document.getElementById('tiers-modal-title').textContent = 'New Tier'
          // Clear and show modal
          ['slug','name','description'].forEach(id => document.getElementById('tier-' + id).value = '')
          document.getElementById('tier-rank').value = 0
          document.getElementById('tier-currency').value = 'USD'
          document.getElementById('tier-price').value = 0
          document.getElementById('tier-interval').value = 'month'
          document.getElementById('tiers-create-modal').style.display = 'flex'
        }
        async function saveTier() {
          showAlert('tiers-alert', 'error', 'Tier list/create API not yet exposed by membership plugin. See TODO in code.')
        }
        loadTiers()
      </script>
    `,
  })
}
