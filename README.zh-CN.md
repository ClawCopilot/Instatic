<div align="center">

# Instatic

**你的网站，你的创作。**

一个自托管的 CMS，可视化编辑器、内容引擎和发布器全部跑在一个 Bun 服务里 —— 发布出来的页面干净到可以直接看源代码。

<p>
  <a href="https://trendshift.io/repositories/66792?utm_source=repository-badge&utm_medium=badge&utm_campaign=badge-repository-66792" target="_blank" rel="noopener noreferrer">
    <img src="https://trendshift.io/api/badge/repositories/66792" alt="CoreBunch/Instatic | Trendshift" width="250" height="55">
  </a>
</p>

[![Release](https://img.shields.io/github/v/release/corebunch/instatic?color=black&labelColor=black)](https://github.com/corebunch/instatic/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-black?labelColor=black&color=blue)](LICENSE)
[![Runtime: Bun](https://img.shields.io/badge/runtime-Bun-black?labelColor=black&color=f9f1e1)](https://bun.sh)
[![TypeScript](https://img.shields.io/badge/TypeScript-everywhere-black?labelColor=black&color=3178c6)](https://www.typescriptlang.org/)

[一键部署](#一键部署) · [快速开始](#快速开始) · [Docker 部署](#docker-部署) · [Cloudflare Tunnel](#cloudflare-tunnel) · [文档](docs/README.md) · [插件](docs/features/plugin-system.md)

<br>

<a href="https://www.youtube.com/watch?v=zyjCF_TaLlg">
  <img src="https://img.youtube.com/vi/zyjCF_TaLlg/maxresdefault.jpg" alt="观看 Instatic 界面演示" width="100%">
</a>

*在 YouTube 上观看 Instatic 介绍视频。*

</div>

<br>

打造一个现代网站通常意味着组装一堆技术栈：无头 CMS、框架、托管平台、表单服务、统计工具、图片 CDN —— 每一项都有一张账单、一个后台，以及凌晨两点的宕机风险。Instatic 走的是反方向。**一个 Bun 服务承载一切**：画布编辑器、内容引擎、媒体库、认证、表单、插件系统、发布器 —— 你爱放哪放哪，SQLite 或 Postgres 任选。

发布出来的东西才是大多数建站工具悄悄妥协的地方：**干净的语义化 HTML 和紧凑的 CSS**，没有任何编辑器的运行时残留在页面里。没有框架运行时，没有 builder 属性，没有 div 汤。页面加载起来就像静态文件 —— 因为大部分时候，它就是。

**MIT 协议。自托管。你的。**

<br>

## 一键部署

点击按钮，等大约两分钟，搞定。部署脚本会自动生成加密密钥、挂载存储卷、配置健康检查。你连终端都不用打开。

<div align="center">

<img src="docs/assets/readme/railway-deploy.gif" alt="一键部署 Instatic 到 Railway" width="80%">

*不到一分钟上线。实拍，未剪辑。*

</div>

<br>

| 平台 | 数据库 | 适用场景 | 部署 |
|---|---|---|---|
| **Railway** · 推荐 | SQLite | 单站点 — 博客、作品集、小型企业站 | [立即部署 →](https://railway.com/deploy/instatic-cms-sqlite?referralCode=Zm9bVJ&utm_medium=integration&utm_source=template&utm_campaign=generic) |
| **Railway** | Postgres | 多作者协作，托管备份，可扩展 | [立即部署 →](https://railway.com/deploy/instatic-cms-postgres?referralCode=Zm9bVJ&utm_medium=integration&utm_source=template&utm_campaign=generic) |
| **Render** | — | — | *即将上线* |
| **Fly.io** | — | — | *即将上线* |
| **DigitalOcean** | — | — | *即将上线* |

对大多数站点来说，SQLite 就是正确的默认选择。有团队协作或需要托管数据库备份时再考虑 Postgres。

### 更新只需重新部署

新版本发布后，重新部署最新镜像即可。数据库和上传文件存在挂载的存储卷里，替换容器不需要重建整个站点。

<br>

## 一个工具，覆盖网站全生命周期

大多数工具只做一件事，剩下的交给你自己去拼凑。Instatic 全包了。

### 🎨 设计

<img src="docs/assets/readme/design-framework.webp" alt="Core Framework 在 Instatic 中运行" width="100%">

编辑器是一个真正的画布，不是一个带预览面板的表单。你可以把多个响应式断点并排放在一起同时编辑。改桌面端的布局，移动端同步响应。想直接编辑真实页面？切换到实时模式就行。

**[Core Framework](https://coreframework.com) 是内置的。** 这是数千名 WordPress 专业用户每天都在用的设计 Token 引擎，在 Instatic 里它是核心系统，不是你需要祈祷别崩溃的插件。

- **颜色 Token 自动生成完整色阶。** 定义一个品牌色，自动获得整套调好的明暗色系。
- **流体数学字体缩放。** 一套随视口自动调整的比例尺，替代手动维护的几十个字号。
- **间距比例尺**，让每个页面、每个断点保持相同的节奏。
- **工具类生成器**输出锁定好的类到一个精简的 `framework.css`。没有冗余，没有重复规则。

你的整个设计系统就是数据。改一个 Token，所有使用它的页面自动更新。

### 🧱 构建

<img src="docs/assets/readme/build-components.webp" alt="编辑可视化组件" width="100%">

- **模块**是基本构建块：容器、文本、图片、按钮、视频、列表、链接、SVG、表单。拖到画布上，任意嵌套。
- **可视化组件**是带类型参数和命名插槽的可复用部件。参数可以是字符串、数字、布尔值、颜色、图片、URL、富文本、枚举，或整个内容插槽。改一次组件，全站所有实例一起更新。
- **模板**处理共享的页面框架。给全站一套布局，给不同文章类型不同的布局，404 页面你自己设计。
- **循环**把布局重复应用到集合上：文章、页面、媒体，或者插件暴露的任何数据源。给循环设几个变体，它会自动交替使用。
- **属于你的 CMS 的表单。** 用语义化字段搭表单，提交数据直接存到你的数据表里。Instatic 可以读取你放置的字段并自动创建对应的表。
- **AI 智能体直接编辑页面。** 描述你想要什么，它在画布上构建出真实可编辑的节点，不是截图或一堵代码墙。28 个工具在底层运作。自带模型：Claude、OpenAI、OpenRouter，或本地 Ollama。你的 Key，你的模型，你的账单。
- **可靠的导入能力。** 粘贴原始 HTML，得到可编辑的节点。或者丢进一整个静态站点（HTML、CSS、图片、字体），超级导入会把它变成页面、样式规则、设计 Token 和媒体文件。

### 🗂 管理

<img src="docs/assets/readme/manage-media.webp" alt="媒体工作区" width="100%">

- **统一的内容模型。** 页面、文章、组件、自定义集合，以及你发明的任何结构化表格，都存在同一个地方：`data_tables` 和 `data_rows`。没有藏在角落的"特殊页面表"。
- **数据工作区**让你设计自己的集合。在 `/admin/data` 创建自定义文章类型和数据表，在电子表格式网格中操作数据行：搜索、排序、筛选、批量发布、批量导出。自定义文章类型有完整的编辑工作流——草稿、定时发布、已发布——以及已发布副本的版本历史。
- **内容工作区**用于写作。文章和集合的专注写作界面，加上实时模式让作者在网站真实设计中编辑，而不是灰色文本域。
- **媒体工作区**像文件管理器一样运作。文件夹和智能文件夹，批量操作，使用追踪，替换工作流。
- **真实的权限控制。** 基于 36 种能力的角色体系、Token 会话、TOTP 双因素认证、账户锁定机制。
- **⌘K 万能命令面板。** 模糊搜索整个后台，跳转到任何地方。
- **草稿就只是草稿。** 未发布的编辑永远不会泄露给访客。

### 📊 分析

<img src="docs/assets/readme/analyze-dashboard.webp" alt="Instatic 仪表盘" width="100%">

- **可自定义的仪表盘。** 12 列网格，拖拽缩放排列小组件。布局按用户保存。插件可以往同一个网格里添加自己的小组件。
- **审计日志。** 每个有意义的后台操作都写一行记录：登录、内容变更、角色编辑、插件生命周期。只追加，不可改写。
- **表单数据是你的。** 提交存在你自己的表里。查询、导出、构建，没有中间商。

这是最新的一根支柱，也是我们正在全力推进的方向。第一方隐私保护分析功能即将到来。

### 🔌 扩展

一个 Instatic 插件是一个包含 manifest 的 zip 包，运行在 **QuickJS-WASM 沙箱**中。没有文件系统，没有环境变量，没有网络——除非站长主动授权。一个插件读不了你的密钥，打不了电话回家。

在沙箱内，SDK 真正能干的事情不少：

- HTTP 路由和自定义后台页面
- 存储和定时后台任务
- 循环数据源，内容循环可以从任何地方拉数据
- 画布模块——编辑器中出现的新的构建块
- 媒体存储适配器和前端资源
- 安装、激活等生命周期钩子

从[插件系统文档](docs/features/plugin-system.md)和[模板插件](examples/plugins/template/README.md)开始。

<br>

## 速度快，因为几乎没什么要加载的

一个已发布的 Instatic 页面基本上就是一个放在磁盘上的文件。没有框架要启动，没有 hydration 步骤，没有数据库往返。浏览器拿到语义化 HTML 和紧凑的样式表，就完事了。访问者和内容之间几乎什么都没有，所以页面感觉是瞬间呈现的。

这种速度不是某个你调的参数，而是发布机制的天然结果：

- **静态页面发布时直接写入磁盘**并原子替换。访客得到的是文件，不是渲染过程。
- **真正会变的路由**击中一个内存缓存，每次发布时整体失效，不会有人看到过期页面。
- **极少数真正需要个性化的部分**由运行时自动检测并懒加载，这个运行时大约 0.7 KB。

<br>

## 快速开始

你只需要 [Bun](https://bun.sh)。默认开发环境跑 SQLite，不需要额外服务。

```sh
git clone https://github.com/corebunch/instatic.git
cd instatic
bun install
bun run dev
```

打开 `http://localhost:5173`。首次访问会引导你创建站点和管理员账户。

想看它真正上线时的样子？`bun run start` 构建后台并通过 Bun 服务在 `http://localhost:3001/admin` 提供。

> **备份一句话：** 备份数据库（Postgres dump 或 SQLite 文件）+ uploads 文件夹 = 备份了整个站点 — [详情](docs/deployment/backup-restore.md)。

<br>

## Docker 部署

### 拉取镜像

```sh
INSTATIC_IMAGE=ghcr.io/corebunch/instatic:latest docker compose -f compose.prod.yml -f compose.sqlite.yml up -d
```

镜像内置了 **Cloudflare Tunnel**（cloudflared）和 **sing-box**（可选代理层），通过 `start.sh` 统一编排。详见 [部署文档](docs-deploy/ci-cd-and-tunnel.md)。

### Docker Compose 叠加模式

每个 Compose 文件负责一层配置，按需组合：

```
compose.prod.yml          ← 基座（app + postgres）
    │
    ├─ compose.sqlite.yml          ← 切换 SQLite
    ├─ compose.build.yml           ← 本地构建
    ├─ compose.cloudflare-tunnel.yml ← Cloudflare 隧道
    └─ compose.tls.yml             ← Caddy HTTPS
```

常用组合：

```bash
# PostgreSQL + ghcr.io 镜像（最小部署）
docker compose -f compose.prod.yml up -d

# SQLite + 本地构建（自托管）
docker compose -f compose.prod.yml -f compose.sqlite.yml -f compose.build.yml up -d

# SQLite + 本地构建 + Cloudflare Tunnel（推荐生产方案）
docker compose -f compose.prod.yml -f compose.sqlite.yml \
  -f compose.build.yml -f compose.cloudflare-tunnel.yml up -d
```

### 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | `3001` | Instatic 监听端口 |
| `DATABASE_URL` | `sqlite:/app/data/cms.db` | 数据库连接 |
| `INSTATIC_SECRET_KEY` | **必需** | 应用加密密钥 |
| `CLOUDFLARE_TUNNEL_TOKEN` | （空） | 设置后自动启用 Cloudflare Tunnel |
| `SING_BOX_CONFIG` | `/app/sing-box-config.json` | （可选）sing-box 配置路径 |

<br>

## Cloudflare Tunnel

> **核心价值：一个命令即可将 Instatic 发布到公网，无需开放任何端口。**

### 为什么需要 Tunnel？

你的服务器可能：
- 没有公网 IP（NAT/家庭宽带/内网环境）
- 不能开放端口（安全策略限制）
- 不想配置繁琐的 Nginx + Let's Encrypt

**Cloudflare Tunnel** 完美解决：cloudflared 主动向 Cloudflare 发起**出站** QUIC 连接，Cloudflare CDN 反向代理到你的服务器。不需要公网 IP，不需要开放端口，流量自带 Cloudflare DDoS 防护。

### 工作原理

```
公网用户
    │
    ▼
Cloudflare CDN (cms.example.com, :443)
    │
    │ QUIC 加密隧道（出站连接，不需要开放端口！）
    ▼
你的服务器 → Instatic 容器 (start.sh)
                └─ cloudflared → localhost:3001
```

### 前置配置（只需一次）

1. 登录 [Cloudflare Zero Trust](https://one.dash.cloudflare.com/)
2. 左侧菜单 → **Networks** → **Tunnels**
3. 点击 **Create a tunnel** → 选 **Cloudflared**
4. 给 Tunnel 起名 → **Save tunnel**
5. 复制 **Token**（`eyJhIjoi...` 开头）
6. 配置 Public Hostname：Subdomain `cms`，Domain `example.com`，Type `HTTP`，URL `localhost:3001`
7. **Save hostname**

### 部署

```bash
# .env 中添加
CLOUDFLARE_TUNNEL_TOKEN=eyJhIjoi...你的Token...

# Compose 方式（推荐）
docker compose -f compose.prod.yml -f compose.sqlite.yml \
  -f compose.build.yml -f compose.cloudflare-tunnel.yml up -d

# docker run 方式
docker run -d --name instatic \
  -e CLOUDFLARE_TUNNEL_TOKEN=eyJhIjoi... \
  -e INSTATIC_SECRET_KEY=$(openssl rand -base64 48) \
  -e DATABASE_URL="sqlite:/app/data/cms.db" \
  -v instatic_data:/app/data \
  -v instatic_uploads:/app/uploads \
  ghcr.io/corebunch/instatic:latest
```

### 验证

```bash
docker logs instatic 2>&1 | grep cloudflared
# 应该看到：
# [cloudflared] Starting Cloudflare Tunnel...
# INF Starting tunnel tunnelID=xxxxx
```

通过你配置的域名（如 `https://cms.example.com`）访问即可。

### 多端口转发（一条隧道承载多个服务）

一个 Cloudflare Tunnel 可以将**不同域名/路径**路由到容器的不同端口，`start.sh` 和 `cloudflared` 不需要任何改动——路由规则全部在 Cloudflare 控制台配置。

| 公网地址 | 转发到 | 服务 |
|----------|--------|------|
| `cms.example.com` | `localhost:3001` | Instatic CMS |
| `proxy.example.com` | `localhost:8080` | sing-box 代理 |

配置步骤：在已有 Tunnel 上 → **Public Hostname** → **Add a public hostname** → 填写域名和端口。

> 一个 `cloudflared tunnel run` 进程天生支持多条路由，无需额外容器。

### sing-box（可选代理层）

> sing-box 是内置在镜像中的**可选代理/协议层**，默认不启动。仅当需要代理功能时才需挂载配置。

挂载配置文件即可启用：

```bash
docker run -d --name instatic \
  -e CLOUDFLARE_TUNNEL_TOKEN=eyJhIjoi... \
  -e INSTATIC_SECRET_KEY=... \
  -v ./my-sing-box.json:/app/sing-box-config.json:ro \
  ghcr.io/corebunch/instatic:latest
```

完整文档见 [Instatic + Cloudflare Tunnel 原理与操作手册](docs-deploy/ci-cd-and-tunnel.md)。

<br>

## 谁在做这个

我们是 **[Motion.page](https://motion.page)** 和 **[Core Framework](https://coreframework.com)** 的团队 —— 数千人用来谋生的建站工具，主要在 WordPress 生态。

我们花了很多年让别人的平台更好用。某个时刻，一个显而易见的问题挥之不去：如果底层的东西一开始就是对的呢？没有要绕开的遗留问题，没有不准碰的标记，没有依赖把你网站锁住的商业模式。

所以我们做了 Instatic。并且把 Core Framework 带了过来，作为核心系统深度集成 —— 颜色色阶、字体比例、间距和工具类这些我们用户已经依赖的东西，是产品的一部分，不是你装上去祈祷别崩的插件。

<br>

## 坦诚地说：这是早期版本

以上所有 —— 画布、Core Framework、统一内容模型、沙箱插件、AI 智能体、表单、循环、模板、媒体、双因素认证、审计日志、一键部署、干净的发布器 —— 是起跑线，不是终点。接下来的方向：

- **真正的分析功能。** 第一方、隐私保护的站点统计。
- **更丰富的模块和插件生态。** 更多内置模块、更多 SDK 能力、更多可复制的示例。
- **更强大的 AI 智能体。** 更多工具，对网站本身的更深理解。
- **一切更紧凑。** 我们刻意保持 0.x 版本，这是扔掉烂想法、保持架构干净最便宜的时候。

API 和工作流在 1.0 之前可能会变。如果这让你紧张，等 1.0 —— 完全理解。如果你更想参与塑造未来二十年"拥有一个网站"是什么样子，现在是最好的时机。

<br>

## 面向开发者

一个 Bun 服务。React 后台 + Vite 构建。发布的页面质量让你自豪。

| | |
|---|---|
| **运行时** | Bun，服务端和工具链统一 |
| **语言** | TypeScript 全覆盖 |
| **后台应用** | React 19（React Compiler 开启），Vite，Zustand + Mutative，CodeMirror，dnd-kit |
| **服务端** | `Bun.serve` + 手写路由 |
| **数据库** | SQLite 或 Postgres — 统一 `DbClient` 接口，`DATABASE_URL` 切换 |
| **校验** | TypeBox 覆盖所有无类型边界，Schema 即真相 |
| **插件** | QuickJS-WASM 沙箱，站长可控权限 |
| **AI** | 提供者无关驱动，原始 HTTP/SSE，无厂商 SDK |
| **输出** | 语义化 HTML，紧凑 CSS，静态文件 + 自动检测动态部分 |

代码库有明确的架构主张，且由代码强制执行。架构规则以实际测试的形式存在于 `src/__tests__/architecture/`，保证输出干净的架构不会悄悄腐化。

```sh
bun run build   # tsc -b && vite build
bun test
bun run lint
```

深入阅读：[文档索引](docs/README.md) · [架构](docs/architecture.md) · [编辑器](docs/editor.md) · [服务端](docs/server.md) · [发布器](docs/features/publisher.md) · [插件系统](docs/features/plugin-system.md)

<br>

## 致谢

Instatic 界面使用 Gerrit Halfmann 的 [Pixelarticons](https://pixelarticons.com/)。感谢 Gerrit 提供如此独特的图标集，并友善地允许我们在开源项目中使用。

## 许可证

MIT。见 [LICENSE](LICENSE)。没有付费版，没有 open-core 星号，没有"联系销售"。
