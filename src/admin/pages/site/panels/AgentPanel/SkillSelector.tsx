/**
 * SkillSelector — multi-select dropdown of installed AI skills.
 *
 * Shown in the input-bar row so the user can opt-in to skills for the
 * current conversation. Only enabled skills (kind === 'skill') are listed.
 * The selection is stored in the agent slice and sent with every message.
 */

import { useState, useRef, useEffect, useCallback } from 'react'
import type { InstalledPlugin } from '@core/plugin-sdk'
import { CheckSolidIcon } from 'pixel-art-icons/icons/check-solid'
import { SparklesSolidIcon } from 'pixel-art-icons/icons/sparkles-solid'
import styles from './AgentPanel.module.css'

interface SkillSelectorProps {
  skills: InstalledPlugin[]
  activeIds: string[]
  onToggle: (skillId: string) => void
}

export function SkillSelector({ skills, activeIds, onToggle }: SkillSelectorProps) {
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  // Close dropdown on outside click
  useEffect(() => {
    if (!open) return
    const handleClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [open])

  // Close on Escape
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') setOpen(false)
  }, [])

  if (skills.length === 0) return null

  const activeCount = activeIds.length
  const triggerLabel = activeCount > 0 ? `Skills (${activeCount})` : 'Skills'

  return (
    <div
      ref={containerRef}
      className={styles.skillDropdown}
      onKeyDown={handleKeyDown}
    >
      <button
        type="button"
        className={styles.skillDropdownTrigger}
        data-active={activeCount > 0}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((prev) => !prev)}
      >
        <SparklesSolidIcon size={12} aria-hidden="true" />
        <span>{triggerLabel}</span>
      </button>

      {open && (
        <ul className={styles.skillDropdownMenu} role="listbox" aria-label="Active skills">
          {skills.map((skill) => {
            const checked = activeIds.includes(skill.id)
            return (
              <li key={skill.id} role="option" aria-selected={checked}>
                <label
                  className={styles.skillDropdownItem}
                  title={skill.manifest.description ?? skill.name}
                >
                  <span className={styles.skillDropdownCheck}>
                    {checked && <CheckSolidIcon size={12} />}
                  </span>
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => onToggle(skill.id)}
                    className={styles.skillDropdownInput}
                  />
                  <span className={styles.skillDropdownLabel}>{skill.name}</span>
                </label>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
