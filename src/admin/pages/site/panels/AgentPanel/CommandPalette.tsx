/**
 * CommandPalette — slash-command dropdown for the chat composer.
 *
 * When the user types "/" in the textarea a floating menu appears above the
 * input bar listing predefined command shortcuts. Arrow keys navigate the
 * list, Enter selects, Escape dismisses. Typing after the "/" filters the
 * list by label or description.
 */

import { useState, useMemo, memo, useRef, useEffect } from 'react'
import styles from './AgentPanel.module.css'

// ---------------------------------------------------------------------------
// Types & commands
// ---------------------------------------------------------------------------

export interface CommandItem {
  id: string
  label: string
  description: string
  prompt: string
}

const COMMANDS: CommandItem[] = [
  { id: 'help', label: 'Help', description: 'Show what I can do', prompt: 'What can you help me build or edit?' },
  { id: 'undo', label: 'Undo last', description: 'Undo the last change', prompt: 'Undo the last change you made and restore the previous state.' },
  { id: 'read', label: 'Read page', description: 'Read current page structure', prompt: 'Read the current page document and describe what you see.' },
  { id: 'screenshot', label: 'Take screenshot', description: 'Capture current page', prompt: 'Take a screenshot of the current page and describe what you see.' },
  { id: 'improve', label: 'Improve design', description: 'Suggest design improvements', prompt: 'Review the current page design and suggest specific improvements for visual hierarchy, spacing, and typography.' },
  { id: 'seo', label: 'Check SEO', description: 'Review SEO setup', prompt: 'Review the current page SEO and suggest improvements.' },
  { id: 'mobile', label: 'Mobile check', description: 'Check mobile layout', prompt: 'Switch to the smallest breakpoint and check if the layout works well on mobile.' },
  { id: 'publish', label: 'Publish', description: 'Publish the site', prompt: 'Check publish status and publish if ready.' },
]

export { COMMANDS }

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface CommandPaletteProps {
  visible: boolean
  query: string
  onSelect: (command: CommandItem) => void
  onClose: () => void
  position: { top: number; left: number } | null
}

const CommandPalette = memo(function CommandPalette({
  visible,
  query,
  onSelect,
  onClose,
  position,
}: CommandPaletteProps) {
  const [selectedIndex, setSelectedIndex] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)

  const filtered = useMemo(() => {
    if (!query) return COMMANDS
    return COMMANDS.filter(
      (c) =>
        c.label.toLowerCase().includes(query.toLowerCase()) ||
        c.description.toLowerCase().includes(query.toLowerCase()),
    )
  }, [query])

  // Reset selection when the filtered list changes
  useEffect(() => {
    setSelectedIndex(0)
  }, [filtered])

  // Global keydown handler for arrow / enter / escape
  useEffect(() => {
    if (!visible) return

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSelectedIndex((i) => Math.min(i + 1, filtered.length - 1))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSelectedIndex((i) => Math.max(i - 1, 0))
      } else if (e.key === 'Enter' && filtered[selectedIndex]) {
        e.preventDefault()
        onSelect(filtered[selectedIndex]!)
      } else if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [visible, filtered, selectedIndex, onSelect, onClose])

  // Scroll the selected item into view
  useEffect(() => {
    const container = listRef.current
    if (!container || filtered.length === 0) return
    const selected = container.children[selectedIndex] as HTMLElement | undefined
    selected?.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex, filtered.length])

  if (!visible || filtered.length === 0) return null

  return (
    <div
      className={styles.commandPalette}
      style={
        position
          ? { bottom: 'auto', top: position.top, left: position.left }
          : undefined
      }
      role="listbox"
      aria-label="Commands"
      ref={listRef}
    >
      {filtered.map((cmd, i) => (
        <div
          key={cmd.id}
          className={
            i === selectedIndex
              ? styles.commandPaletteItemSelected
              : styles.commandPaletteItem
          }
          role="option"
          aria-selected={i === selectedIndex}
          onClick={() => onSelect(cmd)}
          onMouseEnter={() => setSelectedIndex(i)}
        >
          <span className={styles.commandPaletteItemLabel}>{cmd.label}</span>
          <span className={styles.commandPaletteItemDesc}>
            {cmd.description}
          </span>
        </div>
      ))}
    </div>
  )
})

export { CommandPalette }
