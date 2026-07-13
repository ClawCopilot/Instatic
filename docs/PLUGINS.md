# Plugins

Eight first-party plugins ship with this Instatic fork. Each is a self-contained TypeScript package that uses the host's plugin SDK.

## Bundle

| Plugin | ID | Size | Purpose |
|---|---|---|---|
| [api-keys](./plugins/api-keys/) | `instatic.api-keys` | 1.7 MB | API key management + Bearer auth |
| [public-auth](./plugins/public-auth/) | `instatic.public-auth` | 2.1 MB | End-user registration, login, JWT sessions, 2FA, GDPR |
| [membership](./plugins/membership/) | `instatic.membership` | 1.7 MB | Subscription tiers + Stripe billing + paywalls |
| [commerce](./plugins/commerce/) | `instatic.commerce` | 1.9 MB | Products, cart, orders, inventory, coupons, refunds |
| [oidc-provider](./plugins/oidc-provider/) | `instatic.oidc-provider` | 1.8 MB | OAuth 2.0 / OpenID Connect identity provider |
| [notifications](./plugins/notifications/) | `instatic.notifications` | 1.7 MB | Multi-channel email/webhook delivery |
| [social-login](./plugins/social-login/) | `instatic.social-login` | 1.7 MB | Google/GitHub/Apple/WeChat OAuth bridges |
| [rate-limit](./plugins/rate-limit/) | `instatic.rate-limit` | 1.7 MB | Sliding-window rate limiting |

Bundle sizes include the inlined plugin SDK (~1.5 MB shared base).

## Building

```bash
bun run build:plugins
```

Builds all 8 plugins in parallel. Output: `plugins/<name>/dist/index.js` (self-contained ESM bundle).

The build is configured to inline the SDK so each plugin can be uploaded to any host install with no external dependency on `@instatic/plugin-sdk`.

## Plugin architecture

Each plugin source file (`src/index.ts`) exports:

```ts
import { definePlugin } from '@instatic/plugin-sdk'
import migrations from './migrations'

// 1. Manifest: what the plugin declares at install time
export default definePlugin({
  id: 'instatic.my-plugin',                    // MUST be vendor.name
  name: 'My Plugin',
  version: '0.1.0',
  permissions: ['cms.migrations', 'cms.routes'],  // host-side permission gates
  // settings: [...]                              // optional settings schema
})

// 2. Lifecycle hooks — host calls these at appropriate moments
export async function install(api) { /* runs once on first install */ }
export async function activate(api) { /* runs on every (re)activation */ }
export async function deactivate(api) { /* runs on disable */ }
```

The `api` argument is the host's `ServerPluginApi` — see `packages/plugin-sdk/src/types/serverApi.ts` for the full surface.

### Plugin SDK surface (high-level)

```ts
api.cms.migrations.register(migration)   // ship your own DB tables
api.cms.routes.register(method, path, capability, handler)
api.cms.routes.register(method, path, 'public', handler)
api.cms.routes.register(method, path, 'authenticated', handler)
api.cms.publicRoutes.register(prefix, { exclusive: true })
api.cms.httpMiddleware.register(async (ctx) => Response | null)
api.hooks.on('event', handler)
api.viewerContext.register(async (ctx) => viewerData)
api.contentGate.register(async (ctx) => allow | block, priority)
api.settings.get(key)  // read plugin settings
api.secrets.get(key)    // read encrypted secrets
api.db.query(sql, params)
```

## Custom host extensions

Five extension points beyond the standard SDK live in the host at `server/plugins/extensions/`:

| Extension | File | Purpose |
|---|---|---|
| `pluginMigrations` | `migrations.ts` | Plugin-owned DB tables |
| `publicRoutes` | `publicRoutes.ts` | Root-path HTTP routes (OAuth callbacks, etc.) |
| `httpMiddleware` | `httpMiddleware.ts` | Request-pipeline middleware (rate limit, auth) |
| `viewerContext` | `viewerContext.ts` | Per-request viewer state for templates |
| `contentGate` | `contentGate.ts` | Block content rendering (paywall, geo, etc.) |

These are host-side modifications — see [docs/HOST_MODIFICATIONS.md](./HOST_MODIFICATIONS.md) for the contract and a list of changed files.

## Testing

### Type check

```bash
bun run scripts/typecheck-plugins.ts
```

Runs `tsc --noEmit --strict` on every plugin. Must report 0 errors.

### Unit tests

```bash
bun test plugins/
```

262 tests cover pure logic (TOTP, JWT, coupons, shipping, HMAC, rate limiting).

### Integration tests

```bash
bun run scripts/build-plugins.ts
bun run scripts/integration-test-plugins.ts
```

Loads each built plugin and calls its `activate()` against a mock `ServerPluginApi` + in-memory SQLite. Verifies the plugin correctly registers its expected migrations, routes, hooks, and extension points. Must report `8 passed, 0 failed`.

## Installation on a running host

1. Build the plugins: `bun run build:plugins`
2. Open the host admin UI → Plugins → Upload `.tgz`
3. Or, from the CLI: `tar -czf api-keys.tgz -C plugins/api-keys dist package.json manifest.json`
4. The host validates the manifest, runs the migration in a transaction, and calls `activate()`

## Writing a new plugin

1. `mkdir plugins/my-thing && cd plugins/my-thing`
2. Create `package.json` with `instaticManifest` block
3. Create `src/index.ts` exporting the manifest + lifecycle hooks
4. Add to `scripts/build-plugins.ts` plugin list
5. Add unit tests under `tests/`
6. Add integration test entry to `scripts/integration-test-plugins.ts`
7. Add to `tsconfig.json` (automatic via the plugin glob)

## License

MIT (each plugin independently licensed)
