/**
 * Skill-specific types — tools, triggers, and the simplified manifest shape.
 * Skills are lightweight, AI-focused plugins with no sandbox, no entrypoints,
 * no resources, and no admin pages.
 *
 * Unlike full plugins which run in a QuickJS sandbox, skills are declarative:
 * they register AI tools and system prompts that the AI runtime picks up.
 * Skills are installed and managed through the same plugin mechanism, sharing
 * the `installed_plugins` table and the `/admin/api/cms/plugins` API surface.
 */
import type { PluginAuthorMetadata } from './manifest'
import type { PluginSettingDefinition } from '../builders/settings'

// ---------------------------------------------------------------------------
// Skill AI tool — a tool definition that the AI runtime can invoke.
// Tool handlers are resolved at runtime from the skill's server entrypoint.
// ---------------------------------------------------------------------------

export interface SkillAiTool {
  /** Unique name for this tool (scoped to the skill's id). */
  name: string
  /** Human-readable description — the model uses this to decide when to call. */
  description: string
  /** JSON Schema for the tool's input parameters. */
  inputSchema: Record<string, unknown>
  /**
   * Does this tool mutate state? Defaults to false (read-only).
   * When true, the caller must hold `ai.tools.write`.
   */
  mutates?: boolean
}

// ---------------------------------------------------------------------------
// Skill trigger — defines when the skill's system prompt is active.
// ---------------------------------------------------------------------------

export type SkillTrigger =
  /** Always active — system prompt is injected into every AI chat. */
  | { kind: 'always' }
  /**
   * Active only in specific AI scopes.
   * Default: ['plugin'] — skills are only available in the plugin scope.
   */
  | { kind: 'scope'; scopes: ('site' | 'content' | 'data' | 'plugin')[] }

// ---------------------------------------------------------------------------
// Skill manifest — the simplified manifest for skills.
// This is a subset of PluginManifest, with AI-specific additions.
// ---------------------------------------------------------------------------

export interface SkillManifest {
  kind: 'skill'
  id: string
  name: string
  version: string
  apiVersion: number
  description?: string
  author?: PluginAuthorMetadata
  license?: string
  homepage?: string
  repository?: string
  keywords?: string[]
  icon?: string

  /**
   * AI tools this skill contributes to the `plugin` scope.
   * Each tool is registered with the AI runtime when the skill is active.
   */
  aiTools?: SkillAiTool[]

  /**
   * System prompt additions — injected into the AI system prompt
   * when this skill is active. Can contain template variables
   * like `{{skill.settings.apiKey}}` that are resolved at runtime.
   */
  systemPrompt?: string

  /**
   * When this skill's system prompt is active.
   * Defaults to [{ kind: 'always' }] — always active.
   */
  triggers?: SkillTrigger[]

  /**
   * Declarative settings (same schema as plugin settings).
   * Skill settings are rendered in the admin UI just like plugin settings.
   */
  settings?: ReadonlyArray<PluginSettingDefinition>
}