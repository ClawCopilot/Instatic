/**
 * ToolCallRow — one agent tool call rendered as a compact row: category icon,
 * human title · muted detail, status glyph, plus optional colour-token
 * swatches and an inline error message. Captured images are grouped by the
 * parent turn so they share the conversation gallery and preview window.
 */
import { useState, useCallback, type CSSProperties } from 'react'
import type { AgentToolCall } from '@admin/pages/site/agent/types'
import { cn } from '@ui/cn'
import { Tooltip } from '@ui/components/Tooltip'
import { Button } from '@ui/components/Button'
import { LoaderIcon } from 'pixel-art-icons/icons/loader'
import { CheckIcon } from 'pixel-art-icons/icons/check'
import { CircleAlertSolidIcon } from 'pixel-art-icons/icons/circle-alert-solid'
import { WarningDiamondSolidIcon } from 'pixel-art-icons/icons/warning-diamond-solid'
import { TrashSolidIcon } from 'pixel-art-icons/icons/trash-solid'
import { EditSolidIcon } from 'pixel-art-icons/icons/edit-solid'
import { FilePlusSolidIcon } from 'pixel-art-icons/icons/file-plus-solid'
import { LinkIcon } from 'pixel-art-icons/icons/link'
import { CodeIcon } from 'pixel-art-icons/icons/code'
import { PackageSolidIcon } from 'pixel-art-icons/icons/package-solid'
import { Copy2SolidIcon } from 'pixel-art-icons/icons/copy-2-solid'
import { DatabaseSolidIcon } from 'pixel-art-icons/icons/database-solid'
import { FileTextSolidIcon } from 'pixel-art-icons/icons/file-text-solid'
import { ImageSolidIcon } from 'pixel-art-icons/icons/image-solid'
import { MoveIcon } from 'pixel-art-icons/icons/move'
import { ContainerSolidIcon } from 'pixel-art-icons/icons/container-solid'
import { OpenSolidIcon } from 'pixel-art-icons/icons/open-solid'
import { EyeSolidIcon } from 'pixel-art-icons/icons/eye-solid'
import { RulerDimensionSolidIcon } from 'pixel-art-icons/icons/ruler-dimension-solid'
import { ColorsSwatchSolidIcon } from 'pixel-art-icons/icons/colors-swatch-solid'
import { LayoutSolidIcon } from 'pixel-art-icons/icons/layout-solid'
import { UsersSolidIcon } from 'pixel-art-icons/icons/users-solid'
import { ZapSolidIcon } from 'pixel-art-icons/icons/zap-solid'
import { ChevronDownIcon } from 'pixel-art-icons/icons/chevron-down'
import { getToolCallDisplay, extractColorSwatches, isDangerousTool, type ToolCallIcon, type ToolCallTone } from './toolCallDisplay'
import styles from './AgentPanel.module.css'
import confirmationStyles from './ConfirmationOverlay.module.css'

export function ToolCallRow({ toolCall, onScreenshotClick: _onScreenshotClick }: { toolCall: AgentToolCall; onScreenshotClick?: (dataUrl: string) => void }) {
  const isPending = toolCall.status === 'pending'
  const isSuccess = toolCall.status === 'success'
  const isError = toolCall.status === 'error'
  const [expanded, setExpanded] = useState(false)

  const display = getToolCallDisplay(toolCall.actionType, toolCall.params)
  const swatches = extractColorSwatches(toolCall.actionType, toolCall.params)
  const dangerous = isDangerousTool(toolCall.actionType)
  const accessibleStatus = isPending ? 'Running' : isSuccess ? 'Completed' : 'Failed'
  const statusLabel = `${accessibleStatus} ${display.title}${display.detail ? ` — ${display.detail}` : ''}`
  const statusClass = isPending
    ? styles.toolCallStatusPending
    : isSuccess
    ? styles.toolCallStatusSuccess
    : styles.toolCallStatusFailed

  // Surface the tool's error message directly in the row stream so the user
  // sees WHY a tool failed without digging through devtools. The toolResult
  // handler in the agent store already populates `result.error`.
  const errorMessage = isError ? toolCall.result?.error ?? 'Tool call failed.' : null

  // Build a summary string from the tool result data for the expansion area.
  const resultSummary = useCallback((): string | null => {
    const result = toolCall.result
    if (!result) return null
    if (isError) return result.error ?? 'Tool call failed.'
    if (result.data === undefined || result.data === null) return null
    if (typeof result.data === 'string') return result.data
    try {
      const summary = result.data as Record<string, unknown>
      if (typeof summary.message === 'string') return summary.message
      if (typeof summary.summary === 'string') return summary.summary
      // Truncate JSON to a readable size
      const json = JSON.stringify(result.data, null, 2)
      return json.length > 500 ? json.slice(0, 500) + '…' : json
    } catch {
      return String(result.data)
    }
  }, [toolCall.result, isError])

  const detailText = resultSummary()
  const hasExpandableDetail = !isPending && detailText !== null

  const handleToggle = useCallback(() => {
    setExpanded((prev) => !prev)
  }, [])

  return (
    <>
      <div role="status" aria-label={statusLabel} className={styles.toolCallRow}>
        <span className={cn(styles.toolCallIcon, toolCallToneClass(display.tone))} aria-hidden="true">
          <ToolCallLeadingIcon icon={display.icon} />
        </span>
        <span className={styles.toolCallCopy} aria-hidden="true">
          <span className={styles.toolCallTitle}>{display.title}</span>
          {display.detail && <span className={styles.toolCallDetail}>{display.detail}</span>}
        </span>
        <span className={cn(styles.toolCallStatus, statusClass)} aria-hidden="true">
          {isPending ? (
            <LoaderIcon size={11} />
          ) : isSuccess ? (
            <CheckIcon size={11} />
          ) : (
            <CircleAlertSolidIcon size={11} />
          )}
        </span>
      </div>
      {swatches.length > 0 && (
        <div className={styles.toolCallSwatches} aria-hidden="true">
          {swatches.map((swatch) => (
            <Tooltip key={swatch.slug} content={`${swatch.slug} · ${swatch.value}`}>
              <span
                className={styles.toolCallSwatch}
                style={{ '--swatch': swatch.value } as CSSProperties}
              />
            </Tooltip>
          ))}
        </div>
      )}
      {errorMessage && (
        <p role="alert" className={styles.toolCallError}>
          {errorMessage}
        </p>
      )}
      {hasExpandableDetail && (
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className={styles.toolResultToggle}
          onClick={handleToggle}
          aria-expanded={expanded}
        >
          <ChevronDownIcon
            size={10}
            style={{ transform: expanded ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s ease' } as CSSProperties}
          />
          {expanded ? 'Hide details' : 'Show details'}
        </Button>
      )}
      {expanded && hasExpandableDetail && detailText && (
        <div className={styles.toolResultDetail}>
          {detailText}
        </div>
      )}
      {dangerous && !isPending && (
        <div className={confirmationStyles.dangerousWarning} role="alert">
          <WarningDiamondSolidIcon size={10} className={confirmationStyles.dangerousWarningIcon} aria-hidden="true" />
          <span>Destructive operation performed</span>
        </div>
      )}
    </>
  )
}

// Per-tool category icon — signals what kind of action ran at a glance.
function ToolCallLeadingIcon({ icon }: { icon: ToolCallIcon }) {
  switch (icon) {
    case 'add': return <FilePlusSolidIcon size={15} />
    case 'class': return <LinkIcon size={15} />
    case 'code': return <CodeIcon size={15} />
    case 'collection': return <PackageSolidIcon size={15} />
    case 'copy': return <Copy2SolidIcon size={15} />
    case 'data': return <DatabaseSolidIcon size={15} />
    case 'delete': return <TrashSolidIcon size={15} />
    case 'document': return <FileTextSolidIcon size={15} />
    case 'edit': return <EditSolidIcon size={15} />
    case 'media': return <ImageSolidIcon size={15} />
    case 'move': return <MoveIcon size={15} />
    case 'node': return <ContainerSolidIcon size={15} />
    case 'open': return <OpenSolidIcon size={15} />
    case 'page': return <FileTextSolidIcon size={15} />
    case 'preview': return <EyeSolidIcon size={15} />
    case 'runtime': return <RulerDimensionSolidIcon size={15} />
    case 'style': return <ColorsSwatchSolidIcon size={15} />
    case 'template': return <LayoutSolidIcon size={15} />
    case 'tokens': return <ColorsSwatchSolidIcon size={15} />
    case 'users': return <UsersSolidIcon size={15} />
    case 'tool': return <ZapSolidIcon size={15} />
  }
}

// Tone → category-icon colour. Uses state/identity tokens only (danger red,
// style amber, write green); read/neutral stay achromatic.
function toolCallToneClass(tone: ToolCallTone): string {
  switch (tone) {
    case 'danger': return styles.toolCallIconDanger
    case 'read': return styles.toolCallIconRead
    case 'style': return styles.toolCallIconStyle
    case 'write': return styles.toolCallIconWrite
    case 'neutral': return styles.toolCallIconNeutral
  }
}
