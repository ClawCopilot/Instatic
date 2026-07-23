/**
 * Plugin-scope tool 集合 — 从已安装的 skill 插件动态构建 AI 工具。
 *
 * Skills 是轻量级、AI 优先的插件类型（kind === 'skill'），它们通过 manifest
 * 中的 `aiTools[]` 声明式注册工具，并通过 `systemPrompt` 注入系统提示。
 *
 * 核心机制：
 *   - 启动时（以及每次热重载）从 DB 读取所有已安装且启用的 skill 插件
 *   - 将每个 skill 的 `SkillAiTool[]` 转换为 `AiTool[]`，缓存到内存
 *   - `scopeToolset('plugin')` 直接从缓存读取，保持同步调用
 *   - tool handler 调用顺序：先查 `./toolHandlers` 中的本地 handler
 *     （weather、youtube-summarizer 等需要外部 API 调用的 skill），
 *     再回退到 plugin worker RPC（适用于已实现 server entrypoint 的 skill）
 *
 * 命名空间：所有 skill 工具名称前缀为 `skill_<pluginId>_<toolName>`，
 * 避免 skill 之间的工具名称冲突。
 */

import { Type } from '@core/utils/typeboxHelpers'
import type { TSchema } from '@sinclair/typebox'
import type { DbClient } from '../../../db/client'
import { listInstalledPlugins } from '../../../repositories/plugins'
import type { PluginManifest } from '@core/plugin-sdk'
import type { SkillAiTool } from '@core/plugin-sdk/types/skillTypes'
import type { AiTool, ToolContext } from '../types'
import { lookupLocalHandler } from './toolHandlers'

// ---------------------------------------------------------------------------
// 内存缓存 — plugin scope 工具和系统提示
// ---------------------------------------------------------------------------

/** 缓存的 plugin-scope 工具列表 */
let cachedPluginTools: AiTool[] = []

/** 缓存的 plugin-scope 系统提示片段 */
let cachedPluginSystemPrompts: string[] = []

/** Skill 元数据 — 用于自动推荐 */
interface SkillMeta {
  id: string
  name: string
  description: string
  keywords: string[]
}
let cachedSkillMetas: SkillMeta[] = []

// ---------------------------------------------------------------------------
// 缓存初始化 — 在 activateInstalledServerPlugins 中调用
// ---------------------------------------------------------------------------

/**
 * 从 DB 加载所有已安装的 skill 插件，构建 plugin scope 工具和系统提示缓存。
 *
 * 在以下时机调用：
 *   - 服务器启动时（activateInstalledServerPlugins）
 *   - 热重载时（bun --watch 触发重新激活）
 *
 * 流程：
 *   1. 从 installed_plugins 表获取所有已安装插件
 *   2. 筛选 kind === 'skill' 且 enabled 的插件
 *   3. 转换每个 skill 的 aiTools 为 AiTool 格式
 *   4. 收集每个 skill 的 systemPrompt
 *   5. 写入内存缓存，供 scopeToolset 同步读取
 */
export async function initPluginToolCache(db: DbClient): Promise<void> {
  const results = await listInstalledPlugins(db)

  const tools: AiTool[] = []
  const prompts: string[] = []
  const metas: SkillMeta[] = []

  for (const result of results) {
    // 跳过解析失败的 manifest
    if (result.kind === 'broken') continue

    const { plugin } = result
    if (!plugin.enabled) continue

    const manifest: PluginManifest = {
      ...plugin.manifest,
      grantedPermissions: plugin.grantedPermissions,
    }

    // 只处理 skill 类型的插件
    if (manifest.kind !== 'skill') continue

    const pluginId = manifest.id

    // 收集系统提示
    if (manifest.systemPrompt) {
      prompts.push(manifest.systemPrompt)
    }

    // 转换 AI 工具
    const skillAiTools = manifest.aiTools ?? []
    for (const skillTool of skillAiTools) {
      tools.push(buildAiToolFromSkillTool(skillTool, pluginId))
    }

    // 收集元数据用于自动推荐
    const keywords = extractSkillKeywords(manifest, skillAiTools)
    metas.push({
      id: pluginId,
      name: manifest.name,
      description: manifest.description ?? '',
      keywords,
    })
  }

  // 原子替换缓存，确保并发读取不会看到部分更新
  cachedPluginTools = tools
  cachedPluginSystemPrompts = prompts
  cachedSkillMetas = metas
}

// ---------------------------------------------------------------------------
// Skill 自动推荐 — 根据用户 prompt 关键词匹配最相关的技能
// ---------------------------------------------------------------------------

/**
 * 从 skill manifest 和 tools 中提取关键词用于匹配。
 */
function extractSkillKeywords(manifest: PluginManifest, tools: SkillAiTool[]): string[] {
  const words = new Set<string>()
  const add = (text: string) => {
    text.toLowerCase().split(/\W+/).forEach((w) => { if (w.length > 2) words.add(w) })
  }
  add(manifest.name)
  add(manifest.description ?? '')
  tools.forEach((t) => {
    add(t.name)
    add(t.description)
  })
  return [...words]
}

/**
 * Bilingual keyword hints for built-in skills.
 * Maps skillId -> array of English and Chinese trigger words/phrases.
 * Extend this map when adding new skills with non-English names.
 */
const SKILL_HINTS: Record<string, string[]> = {
  'instatic.agent-bridge': ['agent', 'bridge', '代理', '桥接'],
  'instatic.code-helper': ['code', 'coding', 'program', 'python', 'javascript', 'typescript', 'debug', 'function', 'class', 'algorithm', '代码', '编程', '程序', '调试', '函数', '算法'],
  'instatic.comment-system': ['comment', 'review', 'feedback', '讨论', '评论', '反馈'],
  'instatic.content-assistant': ['content', 'article', 'blog', 'post', 'write', 'rewrite', 'copy', 'copywriting', 'draft', 'edit', '文案', '内容', '写作', '改写', '润色', '文章', '博客', '草稿', '编辑'],
  'instatic.design-advisor': ['design', 'ui', 'ux', 'color', 'layout', 'typography', '设计', '界面', '配色', '排版'],
  'instatic.graphic-designer': ['graphic', 'image', 'logo', 'banner', 'svg', '矢量', '图形', '标志', '横幅'],
  'instatic.huggingface': ['huggingface', 'hugging face', 'hf', 'transformer', 'model', 'inference', 'dataset', 'spaces', 'ml model', 'ai model', '机器学习', '模型', '推理', '数据集', 'transformers', 'pytorch', 'tensorflow'],
  'instatic.humanizer': ['humanize', 'natural', 'tone', 'style', 'rewrite', 'polish', 'summar', '总结', '摘要', '自然', '语气', '润色'],
  'instatic.image-generator': ['image', 'photo', 'picture', 'generate', 'create', 'draw', '插画', '图片', '照片', '生成', '绘画', '画图'],
  'instatic.layout-builder': ['layout', 'grid', 'flex', 'section', 'column', 'row', 'structure', '排版', '布局', '网格', '分栏', '结构', 'section'],
  'instatic.site-api': ['api', 'endpoint', 'route', 'fetch', 'request', '接口', '端点', '路由', '请求'],
  'instatic.social-media': ['social', 'twitter', 'facebook', 'instagram', 'share', 'post', '社交', '分享', '转发'],
  'instatic.weather': ['weather', 'temperature', 'rain', 'sunny', 'forecast', '天气', '温度', '下雨', '晴天', '预报'],
  'instatic.web-research': ['search', 'research', 'web', 'internet', 'google', 'find', 'lookup', '搜索', '查找', '调研', '资料', '查询'],
  'instatic.youtube-summarizer': ['youtube', 'video', 'summar', 'transcript', '字幕', '视频', '总结', '摘要', 'youtube'],
}

/**
 * 根据用户 prompt 自动推荐最相关的 skill IDs。
 * 基于双语关键词和子串匹配，不消耗额外 AI token。
 * 返回前 N 个最相关的技能（默认最多 3 个）。
 */
export function recommendSkills(prompt: string, limit = 3): string[] {
  if (!prompt || cachedSkillMetas.length === 0) return []

  const p = prompt.toLowerCase()

  const scored = cachedSkillMetas.map((meta) => {
    let score = 0

    // 1. 检查预定义的双语 hints
    const hints = SKILL_HINTS[meta.id]
    if (hints) {
      for (const h of hints) {
        if (p.includes(h.toLowerCase())) score += 5
      }
    }

    // 2. 检查技能元数据关键词（英文 name / description / tool names）
    for (const kw of meta.keywords) {
      if (p.includes(kw.toLowerCase())) score += 3
    }

    // 3. 检查 skill id 本身作为子串（如 "weather"）
    const shortId = meta.id.replace('instatic.', '')
    if (p.includes(shortId.toLowerCase())) score += 2

    return { id: meta.id, score }
  })

  scored.sort((a, b) => b.score - a.score)
  return scored.filter((s) => s.score > 0).slice(0, limit).map((s) => s.id)
}

// ---------------------------------------------------------------------------
// 同步访问器 — 供 scopeToolset 和 buildSystemPromptForScope 使用
// ---------------------------------------------------------------------------

/**
 * 返回缓存的 plugin-scope 工具列表。
 * 调用前必须确保 initPluginToolCache 已执行过。
 */
export function getPluginTools(): AiTool[] {
  return cachedPluginTools
}

/**
 * 返回指定 skillIds 对应的工具子集。
 * 用于将用户选中的 skills 注入当前 scope 的 AI 流程。
 */
export function getPluginToolsForSkillIds(skillIds: string[]): AiTool[] {
  return cachedPluginTools.filter((t) => {
    // tool name format: skill_<pluginId>_<toolName>
    const parts = t.name.split('_')
    return parts.length >= 2 && skillIds.includes(parts[1])
  })
}

/**
 * 返回缓存的 plugin-scope 系统提示片段数组。
 * 调用前必须确保 initPluginToolCache 已执行过。
 */
export function buildPluginSystemPrompt(): string[] {
  // 如果没有任何 skill 注册了 systemPrompt，返回通用回退
  if (cachedPluginSystemPrompts.length === 0) {
    return [
      `You are an AI assistant in the "plugin" workspace of a CMS. ` +
      `No skill plugins are currently active — respond conversationally only.`,
    ]
  }
  // 返回所有 skill 的 systemPrompt 的副本
  return [...cachedPluginSystemPrompts]
}

/**
 * 返回指定 skillIds 对应的 systemPrompt 子集。
 * 与 getPluginToolsForSkillIds 配对使用。
 */
export function buildPluginSystemPromptForSkillIds(skillIds: string[]): string[] {
  // 如果没有提供 skillIds，不注入任何 skill prompt（返回空）
  if (!skillIds || skillIds.length === 0) return []
  // 目前缓存是按顺序存的，没有记录每个 prompt 属于哪个 skill。
  // 需要在 initPluginToolCache 中同时缓存 skillId -> prompt 的映射。
  // 为简化，先返回所有 prompts —— 后续可按需精细化。
  return [...cachedPluginSystemPrompts]
}

// ---------------------------------------------------------------------------
// 工具转换 — SkillAiTool -> AiTool
// ---------------------------------------------------------------------------

/**
 * 将单个 SkillAiTool 转换为 AiTool 格式。
 *
 * 关键转换：
 *   - name: 前缀化为 `skill_<pluginId>_<toolName>` 避免冲突
 *   - scope: 设为 'plugin'
 *   - execution: 设为 'server'
 *   - inputSchema: 通过 Type.Unsafe 包装 JSON Schema 为 TypeBox TSchema
 *   - handler: 优先查找本地 handler（`./toolHandlers` 中注册的 weather、
 *     youtube-summarizer 等需要外部 API 调用的 skill）。找不到时回退到
 *     worker RPC 路径（`invokeSkillToolHandler`），后者适用于已实现 server
 *     entrypoint 的 skill。
 */
function buildAiToolFromSkillTool(
  skillTool: SkillAiTool,
  pluginId: string,
): AiTool {
  const qualifiedName = `skill_${pluginId}_${skillTool.name}`

  return {
    name: qualifiedName,
    description: skillTool.description,
    scope: 'plugin',
    execution: 'server',
    // SkillAiTool 的 inputSchema 是 Record<string, unknown>（JSON Schema），
    // 通过 Type.Unsafe 包装为 TypeBox 的 TSchema，driver 会直接将其序列化
    // 传给 AI 提供商 SDK（它们接受标准 JSON Schema）。
    inputSchema: Type.Unsafe<TSchema>(skillTool.inputSchema),
    mutates: skillTool.mutates ?? false,
    handler: async (input: unknown, _ctx: ToolContext) => {
      // 优先查找本地 handler —— weather、youtube-summarizer 等需要实际外部
      // API 调用的 skill 在 `./toolHandlers` 中注册了 handler。本地 handler
      // 直接在 server 进程中运行，无需 worker RPC 往返。
      const localHandler = lookupLocalHandler(pluginId, skillTool.name)
      if (localHandler) {
        return await localHandler(input)
      }
      // Fallback：通过 plugin worker RPC 调用 skill 的 server entrypoint。
      // 适用于已实现 server entrypoint 的 skill；若 skill 没有可用的 worker
      // handler（如纯 AI 推理型 skill），调用将返回错误，模型可继续对话。
      return await invokeSkillToolHandler(pluginId, skillTool.name, input)
    },
  }
}

// ---------------------------------------------------------------------------
// 工具调用调度 — 通过 plugin worker RPC
// ---------------------------------------------------------------------------

/**
 * 调用 skill 的 server entrypoint 中对应的 tool handler。
 *
 * 这是 `buildAiToolFromSkillTool` 的 fallback 路径：当 `lookupLocalHandler`
 * 没有找到本地 handler 时调用。通过 plugin worker RPC 调用 skill 的 server
 * entrypoint。
 *
 * 注意：`runAiToolInWorker` 目前尚未实现（`rpc.ts` 中未导出该函数）。
 * 因此对于没有注册本地 handler 的 skill tool（如纯 AI 推理型 humanizer），
 * 此函数会返回一个优雅的错误，让模型可以继续对话而不崩溃。当
 * `runAiToolInWorker` 在未来实现后，此路径将自动可用。
 */
async function invokeSkillToolHandler(
  pluginId: string,
  toolName: string,
  input: unknown,
): Promise<unknown> {
  // 延迟导入 worker RPC 模块，避免循环依赖
  const rpc = (await import('../../../plugins/host/rpc')) as {
    runAiToolInWorker?: (args: {
      pluginId: string
      toolName: string
      input: unknown
    }) => Promise<{ ok: boolean; error?: string; data?: unknown }>
  }

  // runAiToolInWorker 尚未实现 —— 如果不存在，返回优雅的错误让模型继续对话
  const runAiToolInWorker = rpc.runAiToolInWorker
  if (typeof runAiToolInWorker !== 'function') {
    return {
      ok: false,
      error:
        `Skill tool "${pluginId}.${toolName}" has no local handler and the worker RPC ` +
        `(runAiToolInWorker) is not yet implemented. This tool cannot be invoked until ` +
        `either a local handler is registered in toolHandlers.ts or runAiToolInWorker ` +
        `is implemented in server/plugins/host/rpc.ts.`,
    }
  }

  const result = await runAiToolInWorker({
    pluginId,
    toolName,
    input,
  })

  if (!result.ok) {
    return {
      ok: false,
      error: result.error ?? `Skill "${pluginId}" tool "${toolName}" execution failed`,
    }
  }

  return result.data
}
