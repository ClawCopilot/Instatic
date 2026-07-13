# @instatic/plugin-sdk

The Plugin SDK for Instatic. Source lives in the host repo at `src/core/plugin-sdk/` — this package re-exports those modules under a stable, installable name.

## Build all plugins

```bash
bun run build:plugins
```

Builds all 8 plugins in `plugins/*` to `dist/index.js` (self-contained bundles that can be uploaded to the host).

## Quick start for plugin authors

```bash
# 1. Install the SDK in your plugin
mkdir plugins/my-plugin
cd plugins/my-plugin
cat > package.json <<'EOF'
{
  "name": "@instatic/plugin-my-plugin",
  "version": "0.1.0",
  "main": "src/index.ts",
  "instaticManifest": {
    "id": "my-plugin",
    "name": "My Plugin",
    "version": "0.1.0",
    "apiVersion": "1.0.0",
    "permissions": ["cms.migrations", "cms.routes"],
    "entrypoints": { "server": "dist/index.js" }
  }
}
EOF
mkdir src
touch src/index.ts
```

```typescript
// src/index.ts
import { definePlugin } from '@instatic/plugin-sdk'

export default definePlugin({
  id: 'my-plugin',
  name: 'My Plugin',
  version: '0.1.0',
  permissions: ['cms.migrations', 'cms.routes'],
  async activate(api) {
    // Register migrations, routes, hooks, etc.
  },
  async deactivate(api) {
    // Cleanup
  },
})
```

```bash
# Build
bun run build:plugins  # from repo root, OR
bun build src/index.ts --target=bun --outdir dist --external @instatic/*

# The dist/ directory is your plugin package. Upload to the host's
# admin UI as a .tgz (or just point the host at the dist/ folder).
```

## What's exported

The SDK re-exports everything from `src/core/plugin-sdk/`:

- **Builders** (`definePlugin`, `definePack`, `defineModule`, `permissions`, `settings`, `namespace`)
- **Types** (`PluginManifest`, `ServerPluginApi`, `PluginMigrationContext`, etc.)
- **Constants** (`PLUGIN_API_VERSION`, `MIN_SUPPORTED_PLUGIN_API_VERSION`)
- **Schemas** (content, storage)
- **Capabilities** (PLUGIN_CAPABILITIES metadata)

## Custom extensions

The host may include custom extension points beyond the standard SDK:

- `pluginMigrations` — let plugins register their own DB tables
- `publicRoutes` — let plugins own arbitrary root-path HTTP routes
- `httpMiddleware` — let plugins inject request middleware (rate limit, auth, etc.)
- `viewerContext` — let plugins enrich per-request viewer state for templates
- `contentGate` — let plugins block content rendering (paywall, geo-restriction, etc.)

These are exposed as `api.cms.X.register(...)` methods on the `ServerPluginApi`. See `server/plugins/extensions/` for the host-side implementation and `docs/EXTENSIONS.md` for the contract.

## How it works

The host's `src/core/plugin-sdk/` directory contains the canonical SDK source. This package re-exports it under the `@instatic/plugin-sdk` name so that:

1. Plugin code can `import` from a stable package name
2. The bundler can resolve dependencies via the workspace
3. There's a single source of truth (no duplication, no drift)

The host's plugin CLI (`bun run instatic-plugin build`) uses esbuild to bundle the plugin's source. When bundling, the SDK is **inlined** into the output — the plugin's `.tgz` doesn't need `@instatic/plugin-sdk` at runtime.

## Workspace structure

```
instatic/                         # host fork
├── packages/
│   └── plugin-sdk/               # this package (re-exports host's SDK)
│       ├── package.json
│       ├── index.ts
│       └── src/shared/            # shared utilities (stripeWebhook, hmacWebhook)
├── src/core/plugin-sdk/           # canonical SDK source (single source of truth)
├── server/plugins/extensions/     # host extension points (5 modules)
├── plugins/                        # the 8 plugin packages
│   ├── api-keys/
│   ├── public-auth/
│   ├── ...
└── scripts/
    └── build-plugins.ts            # builds all plugins
```

## License

MIT