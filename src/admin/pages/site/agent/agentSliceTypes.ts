import type { EditorStoreSliceCreator } from '@site/store/types'
import type { AiToolOutput, AiUserContentBlock } from '@core/ai'
import type { ConversationView } from '@admin/ai/api'
import type { InstalledPlugin } from '@core/plugin-sdk'
import type { AgentMessage, AgentToolScope } from './types'

export interface AgentSliceConfig {
  /**
   * Conversation scope. Used in URL paths (`/admin/api/ai/chat/${scope}`,
   * `?scope=${scope}`), conversation-create body, and the per-scope default
   * lookup. Keep it aligned with `server/ai/runtime/types.ts → ToolScope`.
   */
  readonly scope: AgentToolScope
  /**
   * Build the per-request snapshot. The slice has no knowledge of the host
   * store's shape; the config closure pulls from whatever store the host
   * mounted the agent in.
   */
  buildSnapshot(): unknown
  /**
   * Dispatch a write-tool request. The slice forwards the server's
   * `toolRequest` event to this function and POSTs the result back.
   */
  dispatchTool(toolName: string, input: unknown): Promise<AiToolOutput>
  /**
   * Optional callback invoked before a dangerous tool executes. Return false
   * to reject the tool. When omitted, all tools run unchecked.
   */
  onToolConfirm?(toolName: string, input: unknown): Promise<boolean>
  /**
   * Optional copy override for the "no AI provider configured" error so
   * each scope can point the user at the right /admin/ai page.
   */
  readonly noProviderMessage?: string
  /**
   * Optional undo/redo callbacks wired to the host store's history.
   * When absent the panel hides the undo/redo buttons.
   */
  undo?(): void
  redo?(): void
  canUndo?(): boolean
  canRedo?(): boolean
}

/**
 * Usage attached to the active conversation.
 *
 * `contextTokens` is the latest provider round's input size, while the other
 * fields are cumulative billing totals across every round in the conversation.
 * Keeping both in one snapshot makes that distinction explicit at call sites.
 */
export interface AgentConversationUsage {
  contextTokens: number | null
  /** Selection that produced `contextTokens`; null until the first measured round. */
  contextCredentialId: string | null
  contextModelId: string | null
  promptTokens: number
  completionTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  costUsd: number
}

export interface AgentSlice {
  isAgentOpen: boolean
  isAgentStreaming: boolean
  agentMessages: AgentMessage[]
  agentError: string | null
  agentConversationId: string | null
  agentActiveCredentialId: string | null
  agentActiveModelId: string | null
  agentConversations: ConversationView[]
  agentContextTokens: number | null
  /** Installed skills (plugins with kind === 'skill'). */
  agentSkills: InstalledPlugin[]
  /** IDs of skills the user has opted-in to for the current conversation. */
  agentActiveSkillIds: string[]
  agentUsage: AgentConversationUsage
  /** True while a history load/delete can replace the active conversation. */
  isAgentConversationPending: boolean
  /** True while an existing conversation's provider/model update is pending. */
  isAgentProviderPending: boolean
  /** Remounts local composer drafts on explicit conversation replacement. */
  agentComposerEpoch: number

  openAgent(): void
  closeAgent(): void
  toggleAgent(): void
  sendAgentMessage(content: AiUserContentBlock[]): Promise<{ accepted: boolean }>
  abortAgent(): void
  clearAgentMessages(): void
  loadAgentConversations(): Promise<void>
  loadAgentConversation(id: string): Promise<void>
  startNewAgentConversation(): void
  deleteAgentConversation(id: string): Promise<void>
  forkAgentConversation(forkAtPosition: number, title?: string): Promise<void>
  setAgentProvider(credentialId: string, modelId: string): Promise<void>
  loadScopeDefault(): Promise<void>
  setOnToolConfirm(handler: ((toolName: string, input: unknown) => Promise<boolean>) | null): void
  /** Load installed skills from the CMS. */
  loadAgentSkills(): Promise<void>
  /** Toggle a skill on/off for the current conversation. */
  toggleAgentSkill(skillId: string): void
  /** Host-store undo/redo proxies (optional — wired via AgentSliceConfig). */
  agentUndo(): void
  agentRedo(): void
  agentCanUndo(): boolean
  agentCanRedo(): boolean
}

export type EditorStoreSet = Parameters<EditorStoreSliceCreator<AgentSlice>>[0]
export type AgentSliceGet = Parameters<EditorStoreSliceCreator<AgentSlice>>[1]
