/**
 * Plugin marketplace page — public-facing list of all 8 first-party plugins.
 * Single self-contained HTML page.
 */

export interface MarketplacePlugin {
  id: string
  name: string
  tagline: string
  category: string
  features: string[]
  docs: string
  icon: string
}

export const MARKETPLACE_PLUGINS: MarketplacePlugin[] = [
  {
    id: 'instatic.api-keys', name: 'API Keys',
    tagline: 'Issue, manage, and authenticate with scoped API keys for machine-to-machine access.',
    category: 'Infrastructure',
    icon: '🔑',
    features: ['Two scopes: admin & public', 'SHA-256 hashed at rest', 'Bearer auth with audit trail', 'Instant revocation'],
    docs: '/plugins/api-keys/README.md',
  },
  {
    id: 'instatic.public-auth', name: 'Public Authentication',
    tagline: 'End-user registration, login, JWT sessions, 2FA, GDPR account deletion.',
    category: 'Authentication',
    icon: '🔐',
    features: ['Argon2id password hashing', 'JWT + server-side sessions', 'TOTP 2FA + recovery codes', 'Magic-link passwordless', 'GDPR export & delete'],
    docs: '/plugins/public-auth/README.md',
  },
  {
    id: 'instatic.membership', name: 'Membership & Paywalls',
    tagline: 'Subscription tiers, Stripe billing, and content gating for membership sites.',
    category: 'Monetization',
    icon: '⭐',
    features: ['Tiered subscriptions', 'Stripe Checkout + webhooks', 'contentGate for paywalls', 'Trial + grace periods', 'Auto viewerContext.tier'],
    docs: '/plugins/membership/README.md',
  },
  {
    id: 'instatic.commerce', name: 'Commerce',
    tagline: 'Products, cart, orders, inventory reservations, coupons, refunds, shipping.',
    category: 'E-commerce',
    icon: '🛒',
    features: ['Product catalog (data tables)', 'Cart with 15-min reservations', 'Stripe Checkout', 'Coupons (% / fixed)', 'Inventory ledger', 'Shipping calculator', 'Partial refunds'],
    docs: '/plugins/commerce/README.md',
  },
  {
    id: 'instatic.oidc-provider', name: 'OIDC Provider',
    tagline: 'Issue ID/access/refresh tokens to third-party applications via OAuth 2.0 + OIDC.',
    category: 'Authentication',
    icon: '🆔',
    features: ['Authorization code + PKCE', 'Refresh token rotation + replay detection', 'RS256 JWKS auto-generated', 'Client credentials grant', 'Token introspection + revocation'],
    docs: '/plugins/oidc-provider/README.md',
  },
  {
    id: 'instatic.notifications', name: 'Notifications',
    tagline: 'Multi-channel notification delivery (email/webhook) for plugin events.',
    category: 'Infrastructure',
    icon: '📬',
    features: ['SMTP email delivery', 'Outbound webhooks with HMAC-SHA256 signing', 'Template engine ({{var}})', '5-min dedup window', 'Default templates for common events'],
    docs: '/plugins/notifications/README.md',
  },
  {
    id: 'instatic.social-login', name: 'Social Login',
    tagline: 'Google / GitHub / Apple / WeChat OAuth bridges. Auto-provisions public_users.',
    category: 'Authentication',
    icon: '🌐',
    features: ['4 providers (Google/GitHub/Apple/WeChat)', 'Account linking by verified email', 'PKCE + state CSRF defense', 'Apple private relay handling'],
    docs: '/plugins/social-login/README.md',
  },
  {
    id: 'instatic.rate-limit', name: 'Rate Limit',
    tagline: 'Per-IP/per-user sliding-window rate limiting. Default rules for login endpoints.',
    category: 'Security',
    icon: '🚦',
    features: ['Sliding window algorithm', '4 scope modes (ip/user/ip+path/user+path)', 'Standard RateLimit-* headers', '5 default rules installed'],
    docs: '/plugins/rate-limit/README.md',
  },
]

export function renderMarketplacePage(): string {
  const plugins = MARKETPLACE_PLUGINS
  const byCategory = plugins.reduce<Record<string, MarketplacePlugin[]>>((acc, p) => {
    (acc[p.category] = acc[p.category] || []).push(p)
    return acc
  }, {})
  const sections = Object.entries(byCategory).map(([cat, ps]) => `
    <section>
      <h2>${cat}</h2>
      <div class="grid">
        ${ps.map(p => `
          <article class="plugin">
            <div class="plugin-head">
              <span class="icon">${p.icon}</span>
              <div>
                <h3><a href="${p.docs}">${p.name}</a></h3>
                <code class="id">${p.id}</code>
              </div>
            </div>
            <p>${p.tagline}</p>
            <ul>${p.features.map(f => `<li>${f}</li>`).join('')}</ul>
            <a class="btn" href="${p.docs}">View docs →</a>
          </article>
        `).join('')}
      </div>
    </section>
  `).join('')

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Plugin Marketplace | Instatic</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font: 15px/1.6 system-ui, -apple-system, sans-serif; color: #1a1a1a; background: #fafafa; }
    header { background: linear-gradient(135deg, #1a1a2e, #2a2a4e); color: #fff; padding: 60px 40px; text-align: center; }
    header h1 { font-size: 40px; margin-bottom: 8px; }
    header p { font-size: 17px; opacity: 0.85; }
    main { max-width: 1200px; margin: 0 auto; padding: 40px 20px 80px; }
    section { margin-bottom: 48px; }
    h2 { font-size: 22px; margin-bottom: 20px; padding-bottom: 8px; border-bottom: 1px solid #e0e0e4; }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 20px; }
    .plugin { background: #fff; border: 1px solid #e8e8ea; border-radius: 10px; padding: 24px; transition: transform 0.15s, box-shadow 0.15s; }
    .plugin:hover { transform: translateY(-2px); box-shadow: 0 8px 24px rgba(0,0,0,0.06); }
    .plugin-head { display: flex; align-items: flex-start; gap: 12px; margin-bottom: 12px; }
    .plugin-head .icon { font-size: 32px; line-height: 1; }
    .plugin-head h3 { font-size: 17px; margin-bottom: 4px; }
    .plugin-head h3 a { color: #1a1a2e; text-decoration: none; }
    .plugin-head h3 a:hover { color: #4a5fcd; }
    .id { font: 11px/1 ui-monospace, "SF Mono", monospace; color: #888; background: #f0f0f2; padding: 2px 6px; border-radius: 3px; }
    .plugin p { color: #444; margin: 8px 0 14px; font-size: 14px; }
    .plugin ul { list-style: none; margin-bottom: 16px; }
    .plugin li { padding: 3px 0 3px 18px; position: relative; font-size: 13px; color: #555; }
    .plugin li::before { content: "✓"; position: absolute; left: 0; color: #4a5fcd; font-weight: 700; }
    .btn { display: inline-block; padding: 8px 16px; background: #1a1a2e; color: #fff; border-radius: 6px; text-decoration: none; font-size: 13px; }
    .btn:hover { background: #2a2a3e; }
    .meta { text-align: center; padding: 20px; color: #888; font-size: 13px; }
  </style>
</head>
<body>
  <header>
    <h1>Plugin Marketplace</h1>
    <p>${plugins.length} first-party plugins for the Instatic platform</p>
  </header>
  <main>${sections}
    <section>
      <h2>Install a plugin</h2>
      <pre style="background:#1a1a2e;color:#e8e8ea;padding:20px;border-radius:8px;font-size:13px"># 1. Build all plugins
bun run build:plugins

# 2. Open the admin UI in your browser
open http://localhost:3000/admin

# 3. Go to Plugins → [Plugin Name] → Settings
# 4. Click "Enable" to activate

# Done — the plugin's API endpoints are now available.
# Configure the plugin's settings as documented in its README.md.</pre>
    </section>
  </main>
  <div class="meta">All 8 plugins are MIT-licensed. See <a href="/docs/PLUGINS.md">PLUGINS.md</a> for the technical reference.</div>
</body>
</html>`
}