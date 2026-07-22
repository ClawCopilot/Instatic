/**
 * SkillSelector — checkbox list of installed AI skills.
 *
 * Shown in the input-bar row so the user can opt-in to skills for the
 * current conversation. Only enabled skills (kind === 'skill') are listed.
 * The selection is stored in the agent slice and sent with every message.
 */

import type { InstalledPlugin } from '@core/plugin-sdk'
import styles from './AgentPanel.module.css'

interface SkillSelectorProps {
  skills: InstalledPlugin[]
  activeIds: string[]
  onToggle: (skillId: string) => void
}

export function SkillSelector({ skills, activeIds, onToggle }: SkillSelectorProps) {
  if (skills.length === 0) return null

  return (
    <div className={styles.skillSelector} role="group" aria-label="Active skills">
      {skills.map((skill) => {
        const checked = activeIds.includes(skill.id)
        return (
          <label
            key={skill.id}
            className={styles.skillChip}
            data-active={checked}
            title={skill.manifest.description ?? skill.name}
          >
            <input
              type="checkbox"
              checked={checked}
              onChange={() => onToggle(skill.id)}
              aria-label={skill.name}
            />
            <span>{skill.name}</span>
          </label>
        )
      })}
    </div>
  )
}
