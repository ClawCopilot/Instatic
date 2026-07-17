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
 *   - tool handler 通过 plugin worker RPC 调用 skill 的 server entrypoint
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

// ---------------------------------------------------------------------------
// 内存缓存 — plugin scope 工具和系统提示
// ---------------------------------------------------------------------------

/** 缓存的 plugin-scope 工具列表 */
let cachedPluginTools: AiTool[] = []

/** 缓存的 plugin-scope 系统提示片段 */
let cachedPluginSystemPrompts: string[] = []

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
  }

  // 原子替换缓存，确保并发读取不会看到部分更新
  cachedPluginTools = tools
  cachedPluginSystemPrompts = prompts
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
 *   - handler: 通过 plugin worker RPC 调用 skill 的 server entrypoint
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
 * 如果 skill 没有加载到 worker 中（无 server entrypoint 或 worker 不可用），
 * 返回错误结果，让模型可以继续对话。
 */
async function invokeSkillToolHandler(
  pluginId: string,
  toolName: string,
  input: unknown,
): Promise<unknown> {
  // 延迟导入 worker RPC 函数，避免循环依赖
  const { runAiToolInWorker } = await import('../../../plugins/host/rpc')

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
