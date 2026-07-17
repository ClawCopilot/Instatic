/**
 * `defineSkill` — type-checked skill configuration.
 *
 * A Skill is a lightweight, AI-focused plugin. Unlike plugins, skills:
 * - Do NOT run in a QuickJS sandbox
 * - Do NOT have entrypoints (server/editor/admin/modules)
 * - Do NOT have resources, admin pages, or frontend assets
 * - Have a simplified permission model
 * - Register AI tools and system prompts instead
 *
 * Usage:
 *   import { defineSkill } from '@instatic/plugin-sdk'
 *
 *   export default defineSkill({
 *     id: 'acme.translator',
 *     name: 'AI Translator',
 *     version: '1.0.0',
 *     description: 'Adds a translate_content tool to the AI assistant.',
 *     aiTools: [
 *       {
 *         name: 'translate_content',
 *         description: 'Translate CMS content to another language',
 *         inputSchema: {
 *           type: 'object',
 *           properties: {
 *             contentId: { type: 'string' },
 *             targetLang: { type: 'string' },
 *           },
 *         },
 *       },
 *     ],
 *     systemPrompt: 'You have the ability to translate content. ' +
 *       'Use translate_content when the user asks for translations.',
 *   })
 */

import { SKILL_API_VERSION } from '../types'
import type { PluginSettingDefinition } from './settings'
import type { SkillAiTool, SkillTrigger, SkillManifest } from '../types/skillTypes'

export interface DefineSkillConfig {
  id: string
  name: string
  version: string
  description?: string
  author?: { name: string; email?: string; url?: string }
  license?: string
  homepage?: string
  repository?: string
  keywords?: string[]
  icon?: string
  apiVersion?: number

  /** AI tools this skill contributes. */
  aiTools?: SkillAiTool[]

  /** System prompt contribution — injected when the skill is active. */
  systemPrompt?: string

  /** Trigger configuration — when the system prompt is active. */
  triggers?: SkillTrigger[]

  /** Declarative settings (same schema as plugin settings). */
  settings?: PluginSettingDefinition[]

  /**
   * Path to the server entrypoint (relative to the skill source root).
   * Only needed for tools that need server-side handler logic.
   * The build script bundles this into the zip.
   */
  server?: string
}

export interface SkillDefinition {
  manifest: SkillManifest
  aiTools: SkillAiTool[]
  systemPrompt: string | null
  triggers: SkillTrigger[]
  server: string | null
}

export function defineSkill(config: DefineSkillConfig): SkillDefinition {
  if (!config.id.includes('.')) {
    throw new Error(
      `[plugin-sdk] Skill id "${config.id}" must be namespaced as "<vendor>.<name>".`,
    )
  }

  // Validate settings
  if (config.settings && config.settings.length > 0) {
    const { validatePluginSettingsDefinitions } = require('./settings')
    validatePluginSettingsDefinitions(config.id, config.settings)
  }

  const manifest: SkillManifest = {
    kind: 'skill',
    id: config.id,
    name: config.name,
    version: config.version,
    apiVersion: config.apiVersion ?? SKILL_API_VERSION,
    ...(config.aiTools !== undefined ? { aiTools: config.aiTools } : {}),
    ...(config.systemPrompt !== undefined ? { systemPrompt: config.systemPrompt } : {}),
    ...(config.triggers !== undefined ? { triggers: config.triggers } : {}),
    ...(config.description !== undefined ? { description: config.description } : {}),
    ...(config.settings !== undefined ? { settings: config.settings } : {}),
    ...(config.author !== undefined ? { author: config.author } : {}),
    ...(config.license !== undefined ? { license: config.license } : {}),
    ...(config.homepage !== undefined ? { homepage: config.homepage } : {}),
    ...(config.repository !== undefined ? { repository: config.repository } : {}),
    ...(config.keywords ? { keywords: [...config.keywords] } : {}),
    ...(config.icon !== undefined ? { icon: config.icon } : {}),
  }

  return {
    manifest,
    aiTools: config.aiTools ?? [],
    systemPrompt: config.systemPrompt ?? null,
    triggers: config.triggers ?? [{ kind: 'always' }],
    server: config.server ?? null,
  }
}