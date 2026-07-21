/**
 * MessageActions — hover-visible action buttons for assistant message groups.
 *
 * Renders a small row of icon buttons (copy prompt, retry) that fades in
 * when the user hovers the parent assistant turn. Uses CSS Module tokens
 * and pixel-art-icons only.
 */

import { memo, useCallback } from 'react'
import { Button } from '@ui/components/Button'
import { Copy2SolidIcon } from 'pixel-art-icons/icons/copy-2-solid'
import { RedoIcon } from 'pixel-art-icons/icons/redo'
import styles from './AgentPanel.module.css'

export interface MessageActionsProps {
  /** The prompt text that preceded this assistant response */
  userPrompt?: string
  /** Retry handler — re-send the same prompt */
  onRetry?: () => void
  /** Copy the prompt to clipboard */
  onCopyPrompt?: (text: string) => void
  /** Whether AI is currently streaming */
  isStreaming?: boolean
}

export const MessageActions = memo(function MessageActions({
  userPrompt,
  onRetry,
  onCopyPrompt,
  isStreaming,
}: MessageActionsProps) {
  const handleCopy = useCallback(() => {
    if (userPrompt && onCopyPrompt) onCopyPrompt(userPrompt)
  }, [userPrompt, onCopyPrompt])

  return (
    <div className={styles.messageActions}>
      <Button
        type="button"
        variant="ghost"
        size="xs"
        iconOnly
        onClick={handleCopy}
        disabled={!userPrompt}
        tooltip="Copy prompt"
        aria-label="Copy prompt"
      >
        <Copy2SolidIcon size={12} />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="xs"
        iconOnly
        onClick={onRetry}
        disabled={isStreaming || !userPrompt}
        tooltip="Retry"
        aria-label="Retry"
      >
        <RedoIcon size={12} />
      </Button>
    </div>
  )
})