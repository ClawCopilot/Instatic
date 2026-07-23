/**
 * AgentSettings — popover panel that lets users toggle AI assistant features.
 *
 * Settings are persisted to localStorage under `instatic:agent-settings`.
 * Each toggle uses the shared `Switch` component and the `useAgentSettings`
 * hook to read/write state.
 *
 * The panel is absolutely positioned relative to the gear icon trigger button,
 * appearing below and right-aligned so it fits within the floating panel.
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import { Switch } from '@ui/components/Switch'
import { ContextMenu } from '@ui/components/ContextMenu'
import { Button } from '@ui/components/Button'
import { AiSettingsSolidIcon } from 'pixel-art-icons/icons/ai-settings-solid'
import { ArrowRightIcon } from 'pixel-art-icons/icons/arrow-right'
import styles from './AgentSettings.module.css'

// ---------------------------------------------------------------------------
// Types & defaults
// ---------------------------------------------------------------------------

export interface AgentSettings {
  /** Show quick action buttons when panel is empty */
  showQuickActions: boolean
  /** Enable voice input button */
  enableVoiceInput: boolean
  /** Enable image upload */
  enableImageUpload: boolean
  /** Enable slash command palette */
  enableCommandPalette: boolean
  /** Confirm before destructive operations */
  confirmDangerousOps: boolean
  /** Auto-collapse old messages when conversation is long */
  autoCollapseMessages: boolean
  /** Show tool result details by default */
  showToolDetails: boolean
  /** Max messages before auto-collapse */
  collapseThreshold: number
}

const SETTINGS_KEY = 'instatic:agent-settings'

const DEFAULT_SETTINGS: AgentSettings = {
  showQuickActions: true,
  enableVoiceInput: true,
  enableImageUpload: true,
  enableCommandPalette: true,
  confirmDangerousOps: true,
  autoCollapseMessages: true,
  showToolDetails: false,
  collapseThreshold: 20,
}

// ---------------------------------------------------------------------------
// Persistence helpers
// ---------------------------------------------------------------------------

function loadSettings(): AgentSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    if (raw) return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) }
  } catch {
    // Corrupted or unreadable — fall back to defaults
  }
  return { ...DEFAULT_SETTINGS }
}

function saveSettings(settings: AgentSettings): void {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

// eslint-disable-next-line react-refresh/only-export-components
export function useAgentSettings() {
  const [settings, setSettingsState] = useState<AgentSettings>(loadSettings)

  const updateSetting = useCallback(
    <K extends keyof AgentSettings>(key: K, value: AgentSettings[K]) => {
      setSettingsState((prev) => {
        const next = { ...prev, [key]: value }
        saveSettings(next)
        return next
      })
    },
    [],
  )

  return { settings, updateSetting }
}

// ---------------------------------------------------------------------------
// Toggle definitions — each row rendered in the settings popover
// ---------------------------------------------------------------------------

interface ToggleDef {
  key: keyof AgentSettings
  label: string
  desc?: string
}

const TOGGLES: ToggleDef[] = [
  { key: 'showQuickActions', label: 'Quick actions', desc: 'Show suggestion chips when idle' },
  { key: 'enableVoiceInput', label: 'Voice input', desc: 'Enable microphone button' },
  { key: 'enableImageUpload', label: 'Image upload', desc: 'Attach images to messages' },
  { key: 'enableCommandPalette', label: 'Command palette', desc: 'Slash-command autocomplete' },
  { key: 'confirmDangerousOps', label: 'Danger confirmations', desc: 'Warn before destructive ops' },
  { key: 'autoCollapseMessages', label: 'Auto-collapse', desc: 'Collapse old messages in long chats' },
  { key: 'showToolDetails', label: 'Tool details', desc: 'Expand tool results by default' },
]

// ---------------------------------------------------------------------------
// SettingsPopover — rendered as a ContextMenu-like panel
// ---------------------------------------------------------------------------

interface SettingsPopoverProps {
  open: boolean
  onClose: () => void
  anchorRef: React.RefObject<HTMLElement | null>
}

function SettingsPopover({ open, onClose, anchorRef }: SettingsPopoverProps) {
  if (!open) return null

  return (
    <ContextMenu
      anchorRef={anchorRef}
      triggerRef={anchorRef}
      align="start"
      side="auto"
      offset={6}
      minWidth={260}
      maxHeight={400}
      ariaLabel="AI Assistant settings"
      onClose={onClose}
    >
      <SettingsPopoverContent />
    </ContextMenu>
  )
}

function SettingsPopoverContent() {
  const { settings, updateSetting } = useAgentSettings()

  return (
    <>
      <div className={styles.settingsPanelTitle}>AI Settings</div>
      {TOGGLES.map((toggle) => {
        const value = settings[toggle.key] as boolean
        return (
          <div key={toggle.key} className={styles.settingsRow}>
            <div className={styles.settingsRowText}>
              <span className={styles.settingsRowLabel}>{toggle.label}</span>
              {toggle.desc && (
                <span className={styles.settingsRowDesc}>{toggle.desc}</span>
              )}
            </div>
            <Switch
              checked={value}
              onCheckedChange={(checked) => updateSetting(toggle.key, checked)}
              switchSize="sm"
            />
          </div>
        )
      })}
      <div className={styles.settingsRow}>
        <div className={styles.settingsRowText}>
          <span className={styles.settingsRowLabel}>Collapse threshold</span>
          <span className={styles.settingsRowDesc}>
            Messages before auto-collapse ({settings.collapseThreshold})
          </span>
        </div>
        <input
          type="number"
          min={5}
          max={100}
          value={settings.collapseThreshold}
          onChange={(e) => {
            const n = parseInt(e.target.value, 10)
            if (!isNaN(n) && n >= 5 && n <= 100) {
              updateSetting('collapseThreshold', n)
            }
          }}
          className={styles.settingsNumberInput}
          aria-label="Collapse threshold"
        />
      </div>
    </>
  )
}

// ---------------------------------------------------------------------------
// SettingsTriggerButton — the gear icon in the AgentPanel header
// ---------------------------------------------------------------------------

/**
 * AgentSettingsButton — replaces the existing internal component in
 * AgentPanel.tsx. When clicked in the header variant, opens the settings
 * popover instead of navigating to /admin/ai.
 *
 * The non-header variants (emptyState, inline) continue to navigate to the
 * AI settings route as before.
 */
export function AgentSettingsButton({
  variant,
  label,
  'data-testid': testId,
}: {
  variant: 'header' | 'emptyState' | 'inline'
  label: string
  'data-testid'?: string
}) {
  const triggerRef = useRef<HTMLButtonElement>(null)
  const [popoverOpen, setPopoverOpen] = useState(false)

  // Close popover on Escape
  useEffect(() => {
    if (!popoverOpen) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault()
        setPopoverOpen(false)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [popoverOpen])

  if (variant === 'header') {
    return (
      <>
        <Button
          ref={triggerRef}
          type="button"
          variant="ghost"
          size="xs"
          iconOnly
          onClick={() => setPopoverOpen((v) => !v)}
          tooltip={label}
          aria-label={label}
          aria-haspopup="menu"
          aria-expanded={popoverOpen}
          data-testid={testId}
        >
          <AiSettingsSolidIcon size={14} aria-hidden="true" />
        </Button>
        <SettingsPopover
          open={popoverOpen}
          onClose={() => setPopoverOpen(false)}
          anchorRef={triggerRef}
        />
      </>
    )
  }

  // Non-header variants are unchanged — they navigate to the AI settings route.
  return (
    <Button
      type="button"
      variant="secondary"
      size={variant === 'emptyState' ? 'md' : 'sm'}
      onClick={() => {
        window.location.href = '/admin/ai'
      }}
      aria-label={label}
      data-testid={testId}
    >
      <AiSettingsSolidIcon size={14} aria-hidden="true" />
      <span>{label}</span>
      <ArrowRightIcon size={12} aria-hidden="true" />
    </Button>
  )
}
