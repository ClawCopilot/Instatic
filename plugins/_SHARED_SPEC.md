# Instatic 插件开发规范

每个插件都是独立的 npm 包，可以被 Instatic 安装、激活、卸载。插件通过 5 个核心扩展点访问宿主能力。

## 文件结构

每个插件目录必须包含：

```
plugins/<plugin-name>/
├── package.json          # npm 包元数据 + Instatic manifest 内嵌
├── README.md             # 使用文档
├── src/
│   ├── index.ts          # 入口点，导出 activate/deactivate 钩子
│   ├── migrations.ts     # SQL 迁移（export default 一组 PluginMigration 对象）
│   ├── store.ts          # 数据库 CRUD（可选）
│   ├── routes.ts         # 公开路由处理器（可选）
│   ├── auth.ts           # 认证/会话逻辑（可选）
│   └── types.ts          # 内部类型定义（可选）
└── tests/                # 单元测试（可选）
```

## package.json 模板

```json
{
  "name": "@instatic/plugin-<name>",
  "version": "0.1.0",
  "description": "...",
  "main": "src/index.ts",
  "scripts": {
    "build": "bun build src/index.ts --target=bun --outdir=dist"
  },
  "instaticManifest": {
    "id": "<plugin-id>",
    "name": "...",
    "version": "0.1.0",
    "apiVersion": "<current-api-version>",
    "description": "...",
    "permissions": [...],
    "entrypoints": {
      "server": "dist/index.js"
    },
    "resources": []
  }
}
```

## src/index.ts 模板

```typescript
import { definePlugin } from '@instatic/plugin-sdk'

export default definePlugin({
  id: '<plugin-id>',
  name: '...',
  version: '0.1.0',

  // 迁移列表 - 在 activate 之前由 host 运行
  migrations: import('./migrations').then(m => m.default),

  // 激活钩子 - 注册路由、扩展点、hook 监听器等
  async activate(api) {
    // 1. 注册 SQL 迁移
    await api.cms.migrations.register(...)

    // 2. 注册路由（管理员 scope）
    await api.cms.routes.register('/admin/api/plugin-keys', 'users.manage', async (req, ctx) => {
      // ...
    })

    // 3. 注册公开路由（OAuth / webhooks 等）
    await api.cms.publicRoutes.register('/api/auth', { exclusive: true })

    // 4. 注册 viewer context provider（用于会员状态）
    api.viewerContext.register(async ({ db, req, url }) => {
      // ...
      return { tier: 'gold' }
    })

    // 5. 注册 content gate（用于付费墙）
    api.contentGate.register(async ({ db, row, viewer }) => {
      // ...
      return { kind: 'allow' }
    }, 100)
  },

  async deactivate() {
    // 清理逻辑（host 自动清理 routes/hooks/gates）
  },
})
```

## 5 个核心扩展点的 API

### 1. `api.cms.migrations.register(migration)`

```typescript
await api.cms.migrations.register({
  id: '<plugin-id>.<migration-name>',  // 必须以 plugin id 开头
  pgSql: 'CREATE TABLE ...',           // Postgres dialect
  sqliteSql: 'CREATE TABLE ...',       // SQLite dialect（可选，缺省用 pgSql）
})
```

### 2. `api.cms.routes.register(path, capability|kind, handler)`

```typescript
// 受 capability 保护
await api.cms.routes.register('/admin/api/keys', 'users.manage', async (req, ctx) => {
  return Response.json({ keys: [] })
})

// 已认证用户
await api.cms.routes.register('/admin/api/profile', 'authenticated', handler)

// 公开访问
await api.cms.routes.register('/api/auth/login', 'public', handler)
```

### 3. `api.cms.publicRoutes.register(prefix, options)`

```typescript
await api.cms.publicRoutes.register('/api/auth', {
  exclusive: true,  // 第一个注册的获胜
})
// 然后注册具体路径的处理器：
await api.cms.routes.register('/api/auth/login', 'public', loginHandler)
await api.cms.routes.register('/api/auth/register', 'public', registerHandler)
```

### 4. `api.viewerContext.register(provider)`

```typescript
api.viewerContext.register(async ({ db, req, url, pathname }) => {
  // 从 cookie/header 解析用户身份
  // 返回 partial viewer 对象，会与其他 provider 合并
  return { userId: '...', tier: 'gold', email: '...' }
})
```

模板中可通过 `{viewer.tier}` 或 viewer 绑定源访问。

### 5. `api.contentGate.register(gate, priority?)`

```typescript
api.contentGate.register(async ({ db, row, viewer, req, url, pathname }) => {
  // 付费墙：members-only 内容对未登录用户 302 跳转到登录页
  if (row.cells.requiresTier && !viewer.tier) {
    return { kind: 'block', redirectTo: '/login', status: 302 }
  }
  return { kind: 'allow' }
}, 100)  // 数字越小优先级越高
```

## 命名约定

- 插件 ID：`@instatic/plugin-<name>` (npm) 和 `<plugin-id>` (manifest)
- 数据库表：`<plugin_id>_<table_name>` (避免冲突)
- 路由前缀：`/admin/api/<plugin-id>/...` 或 `/api/<plugin-id>/...`
- 视图字段：`viewer.<plugin-id>.<field>` (可选)

## 测试

每个插件应该有单元测试，使用 bun:test。测试应该 mock DbClient。

```typescript
import { describe, test, expect } from 'bun:test'

describe('api-keys plugin', () => {
  test('generates 32-char token', () => {
    // ...
  })
})
```

## 打包与发布

1. `bun run build` 编译 TypeScript 到 dist/
2. `npm pack` 生成 .tgz
3. 在 Instatic admin UI 上传 .tgz
4. 在安装对话框中批准所需权限
5. 插件激活，迁移自动运行

## 清单

每个插件完成时确保：

- [ ] package.json 包含 instaticManifest
- [ ] migrations.sql 至少 1 个迁移
- [ ] activate 钩子注册了所有声明的能力
- [ ] deactivate 钩子清理注册的资源
- [ ] README 包含安装步骤、配置说明、API 文档
- [ ] TypeScript 编译无错误
- [ ] 数据库 schema 与 PG/SQLite 兼容