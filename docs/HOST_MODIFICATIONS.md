# Host Modifications

This Instatic fork includes five extensions to the host's plugin system that are NOT part of the upstream instatic plugin API. They were added to enable the first-party plugin set (commerce, membership, OIDC, etc.) without requiring upstream changes.

## Why this document exists

The five extensions modify the host's source code at:

- `server/db/migrations-pg.ts` (new migration `020_plugin_migrations_registry`)
- `server/db/migrations-sqlite.ts` (new migration)
- `server/plugins/host/apiDispatch.ts` (3 new target handlers)
- `server/plugins/host/rpc.ts` (no change — uses existing api-call mechanism)
- `server/plugins/protocol/apiCallSchema.ts` (3 new schemas)
- `server/plugins/protocol/targets.ts` (3 new permission mappings)
- `server/plugins/extensions/*` (NEW directory, ~10 files)
- `server/router.ts` (3 new route handlers for plugin middleware + public routes)
- `server/index.ts` (boot-time init for extensions + plugin migrations)
- `server/publish/publicRenderer.ts` (viewer context injection)
- `server/publish/publicRouter.ts` (content gate application)
- `src/core/templates/renderDataContext.ts` (new `viewer` frame)
- `src/core/templates/tokenInterpolation.ts` (new `viewer` source)

## The five extension points

### 1. `pluginMigrations` — plugin-owned DB tables

**Why**: upstream instatic plugins can only use `cms.storage` (JSON KV) or shared `data_tables`. Neither supports relational data, indexes, or transactions.

**Files**:
- `server/plugins/extensions/migrations.ts` — registry + atomic migration runner
- `server/plugins/extensions/migrationsProtocol.ts` — host-side handler for `cms.migrations.register`
- `server/db/migrations-pg.ts` — adds `plugin_migrations` table (migration `020_plugin_migrations_registry`)
- `server/index.ts` — calls `runPluginMigrations()` after activate

**API surface**:
```ts
api.cms.migrations.register({
  id: 'my-plugin.001_initial',
  pgSql: 'CREATE TABLE ...',
  sqliteSql: 'CREATE TABLE ...',  // optional
})
```

**Tradeoff**: forks with this extension can ship plugins that own their own tables. Forks without it must use `cms.storage` (JSON).

### 2. `publicRoutes` — root-path HTTP routes

**Why**: upstream instatic plugins can only register routes under `/admin/api/cms/plugins/<id>/runtime/...`. OAuth callbacks, public APIs, and webhook receivers need arbitrary root paths.

**Files**:
- `server/plugins/extensions/publicRoutes.ts` — registry + dispatcher
- `server/plugins/extensions/publicRoutesProtocol.ts` — host-side handler for `cms.publicRoutes.register`
- `server/router.ts` — adds `tryServePluginPublicRoute` after the public-render handler

**API surface**:
```ts
api.cms.publicRoutes.register('/api/auth', { exclusive: true })
api.cms.routes.register('POST', '/api/auth/login', 'public', handler)
```

**Tradeoff**: enables OAuth 2.0 providers and public APIs from plugins.

### 3. `httpMiddleware` — request-pipeline middleware

**Why**: upstream plugins cannot intercept incoming requests (e.g. for rate limiting or per-request auth).

**Files**:
- `server/plugins/extensions/httpMiddleware.ts` — registry + chain runner
- `server/plugins/extensions/httpMiddlewareProtocol.ts` — host-side handler
- `server/router.ts` — adds `tryServePluginMiddleware` as the FIRST route handler

**API surface**:
```ts
api.cms.httpMiddleware.register(async (ctx) => {
  // ctx: { db, req, state }
  if (rateLimitExceeded(ctx)) return new Response('429', { status: 429 })
  return null  // pass through
})
```

**Tradeoff**: enables the `rate-limit` plugin. Forks without it would need per-route auth in each plugin.

### 4. `viewerContext` — per-request viewer state for templates

**Why**: upstream instatic has no concept of "current viewer" accessible to templates. Membership/paywall plugins need to know the user's tier at render time.

**Files**:
- `server/plugins/extensions/viewerContext.ts` — registry + merge logic
- `server/publish/publicRenderer.ts` — calls `resolveViewerContext()` on every render
- `src/core/templates/renderDataContext.ts` — adds `viewer?: ViewerFrame` to `TemplateRenderDataContext`
- `src/core/templates/tokenInterpolation.ts` — adds `viewer` as a binding source

**API surface**:
```ts
api.viewerContext.register(async (ctx) => {
  return { loggedIn: true, userId: '...', tier: 'premium', tierRank: 10 }
})
```

**Template access**:
```html
{{#if viewer.tier == "premium"}}...{{/if}}
{viewer.tierRank}
{viewer.loggedIn}
```

**Tradeoff**: enables membership-gated content. The `public-auth` plugin provides the `viewer.loggedIn` / `viewer.userId` claims; the `membership` plugin adds `viewer.tier` / `viewer.tierRank`.

### 5. `contentGate` — block content rendering

**Why**: paywall plugins need to short-circuit the public render pipeline when content is gated.

**Files**:
- `server/plugins/extensions/contentGate.ts` — registry + chain runner
- `server/publish/publicRouter.ts` — calls `applyContentGate()` before rendering a row
- `server/publish/contentEvents.ts` — emits the event after the row is loaded

**API surface**:
```ts
api.contentGate.register(async (ctx) => {
  if (row.cells.requiresTier && viewer.tierRank < requiredRank) {
    return { kind: 'block', redirectTo: '/pricing', status: 302 }
  }
  return { kind: 'allow' }
}, 100)  // priority
```

**Tradeoff**: enables membership paywalls. Forks without it would need to add gating logic in templates (ugly and error-prone).

## Permission model

Each extension requires its own permission in the plugin manifest:

```ts
permissions: [
  'cms.migrations',         // pluginMigrations
  'cms.routes',
  'cms.routes.public',
  'cms.publicRoutes',       // publicRoutes
  'cms.httpMiddleware',     // httpMiddleware
  'cms.hooks',              // general hook system (upstream)
]
```

These are added to `src/core/plugin-sdk/types/permissions.ts` and `PLUGIN_PERMISSION_VALUES` so they appear in the admin UI's install dialog.

## Why these aren't upstream PRs yet

Each extension is a non-trivial change to the plugin loader, route table, or render pipeline. Proposing them upstream requires:
- API design review (Logto-style: should some of these be in the SDK or as core features?)
- Backward-compat: existing plugins that don't declare these permissions still work
- Docs: this doc + the SDK types
- Test coverage: not just unit tests but also a plugin that uses each

Filing upstream PRs is on the TODO list (see [`README.md` § TODO](../../README.md#todo)).

## Removing an extension

If you need to roll back one of these:

1. Delete `server/plugins/extensions/<name>.ts` and `<name>Protocol.ts`
2. Remove the imports from `server/plugins/host/apiDispatch.ts` and `server/router.ts`
3. Remove the corresponding schemas from `server/plugins/protocol/apiCallSchema.ts`
4. Remove the permission from `src/core/plugin-sdk/types/permissions.ts`
5. Remove the host-side call from `server/index.ts` / public renderers
6. Remove the new migration from `server/db/migrations-pg.ts` and `migrations-sqlite.ts`
7. Update any affected plugins to not use the removed extension

The 5 extensions are designed to be **independently removable** — each one's call sites are isolated to 2-3 files.
