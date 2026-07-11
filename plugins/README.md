# Instatic 插件集

5 个独立的 Instatic 插件，构建在 5 个核心扩展点之上。

## 插件列表

| 插件 | 用途 | 依赖的核心扩展点 |
|---|---|---|
| [@instatic/plugin-api-keys](./api-keys) | API Key 管理 + Bearer 认证 | pluginMigrations, publicRoutes, httpMiddleware |
| [@instatic/plugin-public-auth](./public-auth) | 公开用户注册/登录/JWT | pluginMigrations, publicRoutes, viewerContext |
| [@instatic/plugin-membership](./membership) | 会员/订阅/付费墙 | pluginMigrations, publicRoutes, viewerContext, contentGate |
| [@instatic/plugin-commerce](./commerce) | 电商目录/购物车/订单 | pluginMigrations, publicRoutes, contentAccess (data tables) |
| [@instatic/plugin-oidc-provider](./oidc-provider) | OAuth 2.0 / OIDC Provider | pluginMigrations, publicRoutes |

## 安装顺序

```
1. api-keys              (no dependencies)
2. public-auth           (no dependencies)
3. membership            (depends on public-auth)
4. commerce              (depends on public-auth, optional membership for member pricing)
5. oidc-provider         (depends on public-auth)
```

## 共同架构

每个插件遵循相同的目录结构：

```
plugins/<plugin-id>/
├── package.json          # npm 包 + Instatic manifest
├── README.md             # 安装/使用文档
└── src/
    ├── index.ts          # 入口：activate/deactivate 钩子
    ├── migrations.ts     # SQL 迁移
    ├── store.ts          # 数据库 CRUD (可选)
    ├── routes.ts         # HTTP 路由处理器 (可选)
    └── *.ts              # 其他领域特定代码
```

## 打包与发布

每个插件可以独立打包：

```bash
cd plugins/<plugin-id>
npm install
npm run build
npm pack    # 生成 .tgz
```

然后通过 Instatic admin UI 上传 .tgz 文件。

## 配置

每个插件的 settings 在 admin UI 的 "Plugin Settings" 页面配置。

敏感字段（JWT secret、Stripe key 等）使用 `secret: true` 标记，会被加密存储在 `plugin_secrets` 表中。

## 插件协作

插件之间通过 **hook 事件** 和 **viewerContext 共享数据** 协作：

```typescript
// public-auth 触发的事件
api.hooks.emit('public-auth.userRegistered', { userId, email, ... })
api.hooks.emit('public-auth.userLoggedIn', { userId, sessionId })
api.hooks.emit('public-auth.passwordResetRequested', { userId, email, resetToken })

// commerce 触发的事件
api.hooks.emit('commerce.orderPaid', { orderId })
```

订阅方式：

```typescript
api.hooks.on('public-auth.userRegistered', async (payload) => {
  // 发送欢迎邮件
})
```

## 完整示例：搭建会员制电商网站

1. 安装 5 个插件
2. 配置 public-auth 的 jwtSecret
3. 配置 commerce 的 stripeSecretKey + stripeWebhookSecret
4. 配置 membership 的 gracePeriodDays + trialDays
5. 配置 oidc-provider 的 issuer URL
6. 在 admin UI 创建会员 tier (e.g. "Premium $9.99/month")
7. 创建产品 (data table `products`)
8. 在产品行设置 `requiresTier = "premium"` → 仅 Premium 会员可见
9. 配置 Stripe webhook 指向 `/api/membership/stripe/webhook` 和 `/api/commerce/stripe/webhook`

现在你的 Instatic 实例拥有了完整的会员电商能力，同时还是 OIDC IdP。

## 完整示例：搭建 Logto 风格的 IDP

仅安装 public-auth + oidc-provider：

1. 配置 public-auth 的 jwtSecret + 注册/登录 UI
2. 配置 oidc-provider 的 issuer URL
3. 在 admin UI 注册 OAuth 客户端（你的应用）
4. 你的应用现在可以发起标准 OIDC 流程：
   - 引导用户到 `/oauth/authorize?...`
   - 用返回的 code 调 `/oauth/token` 换取 tokens
   - 用 access_token 调 `/oauth/userinfo` 获取用户信息

## License

MIT (each plugin independently)