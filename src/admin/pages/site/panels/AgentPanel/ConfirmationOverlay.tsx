/**
 * ConfirmationOverlay — re-exports for the dangerous operation warning.
 *
 * The actual warning rendering lives in ToolCallRow.tsx (it reads the
 * `isDangerousTool()` predicate from toolCallDisplay.ts and renders a
 * danger-toned banner). This module serves as the canonical home for the
 * feature's CSS module and the `useAgentSettings` integration hook that
 * consumers can use to gate the warning behind the `confirmDangerousOps`
 * toggle.
 */

export { isDangerousTool } from './toolCallDisplay'
export { useAgentSettings } from './AgentSettings'
export type { AgentSettings } from './AgentSettings'
