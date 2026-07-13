# Admin UI

The host ships with two admin surfaces:

1. **React admin shell** at `/admin/*` — full UI for content, pages, media, users, plugins, etc.
2. **Plugin admin pages** (this document) — self-contained HTML+JS pages for plugin CRUD

## Plugin admin pages

Each of the 8 first-party plugins exposes admin functionality via the host's `/admin/api/...` endpoints. To make these operations usable from a browser, we ship a minimal admin UI at:

| URL | Auth | Purpose |
|---|---|---|
| `/marketplace` | public | Browse + install the 8 first-party plugins |
| `/admin/plugins/api-keys` | `users.manage` | Issue/revoke Bearer tokens for the host API |
| `/admin/plugins/oidc-clients` | `users.manage` | Register/manage OAuth 2.0 clients |
| `/admin/plugins/membership-tiers` | `users.manage` | Create/edit membership tiers (requires membership plugin to expose tier list endpoint) |

### Why standalone HTML+JS, not React

The host's admin shell is a full React app with state management, routing, and a component library. Building new pages in it requires understanding all of that. The plugin admin pages deliberately take a different approach:

- **Self-contained**: a single HTML file with inline CSS + vanilla JS
- **No build step**: no React, no webpack, no TypeScript
- **Direct fetch() to plugin APIs**: no admin-API client layer to maintain
- **Trivial to extend**: ~300 lines per page; can be added/removed by any plugin author

This means each plugin's admin UI is independent and doesn't entangle with the host's React architecture.

### Adding a new plugin admin page

1. Add a render function to `server/plugins/adminUi/<name>Page.ts` returning HTML
2. Add the route to `handlePluginAdminPages()` in `server/plugins/adminUi/routes.ts`
3. Add a nav link in the shared shell (modify `SHELL_HEAD` in `apiKeysPage.ts`)

Example:

```ts
// server/plugins/adminUi/myPage.ts
export function renderMyPage(): string {
  return renderPage({
    title: 'My Plugin',
    active: 'mypage',
    body: `<h2>My Plugin</h2>...`,
  })
}
```

## Marketplace

The marketplace at `/marketplace` is a public-facing page that lists all 8 first-party plugins with:

- Plugin name + tagline
- Category (Authentication, E-commerce, Infrastructure, etc.)
- Feature list (5 bullet points per plugin)
- Link to per-plugin README

The data is hard-coded in `server/plugins/adminUi/marketplacePage.ts` as `MARKETPLACE_PLUGINS`. To add a new plugin to the marketplace, append an entry to that array.

The page is a single self-contained HTML file. Open `/marketplace` in any browser to preview it.

## Source files

```
server/plugins/adminUi/
├── apiKeysPage.ts          # API key management (renderApiKeysPage)
├── marketplacePage.ts      # Marketplace (renderMarketplacePage)
└── routes.ts              # URL → page dispatcher (handlePluginAdminPages)
```

The page renderers share a common shell via `renderPage()` (defined in `apiKeysPage.ts`). The shell includes:

- Sidebar with links to all admin pages + marketplace
- Inline CSS (~150 lines) — no external stylesheet
- A `fetch()` helper, an `api()` wrapper that handles auth/JSON, and a `showAlert()` helper
