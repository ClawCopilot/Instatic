/**
 * QuickActions — horizontal scrollable row of pill-shaped prompt shortcuts.
 *
 * Shown below the textarea (above the controls row) when the conversation is
 * empty. Each button fills the textarea with a starter prompt for the current
 * scope. Actions are defined per scope so the suggestions stay relevant.
 */

import type { AgentToolScope } from '@site/agent'
import { Button } from '@ui/components/Button'
import styles from './AgentPanel.module.css'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface QuickAction {
  id: string
  label: string
  prompt: string
}

export type QuickActionsScope = AgentToolScope

interface QuickActionsProps {
  scope: QuickActionsScope
  visible: boolean
  onSelect: (prompt: string) => void
}

// ---------------------------------------------------------------------------
// Per-scope action definitions
// ---------------------------------------------------------------------------

const SITE_QUICK_ACTIONS: QuickAction[] = [
  { id: 'hero', label: 'Add hero section', prompt: 'Add a hero section with a heading, subheading, and a call-to-action button.' },
  { id: 'navbar', label: 'Build navigation', prompt: 'Build a responsive navigation bar with the site name and a few links.' },
  { id: 'cards', label: 'Add feature cards', prompt: 'Add a section with 3 feature cards in a responsive grid layout.' },
  { id: 'footer', label: 'Add footer', prompt: 'Add a footer with copyright, links, and social icons.' },
  { id: 'colors', label: 'Set up colors', prompt: 'Set up a color design system with primary, secondary, accent, neutral, and background tokens.' },
  { id: 'responsive', label: 'Fix responsive', prompt: 'Review the current page and fix any responsive layout issues across all breakpoints.' },
]

const CONTENT_QUICK_ACTIONS: QuickAction[] = [
  { id: 'blog', label: 'Write a blog post', prompt: 'Write a new blog post about the topic I describe next.' },
  { id: 'seo', label: 'Optimize SEO', prompt: 'Review and optimize the SEO fields (title, description) for the current document.' },
  { id: 'translate', label: 'Translate content', prompt: 'Translate the current document into another language. I will specify the language.' },
]

const DATA_QUICK_ACTIONS: QuickAction[] = [
  { id: 'create-table', label: 'Create table', prompt: 'Create a new data table. I will describe the fields and purpose.' },
  { id: 'import', label: 'Import data', prompt: 'Help me import data from CSV or JSON. I will provide the data.' },
  { id: 'health', label: 'Health check', prompt: 'Run a content health check to find issues across all collections.' },
  { id: 'publish', label: 'Publish site', prompt: 'Check the publish status and publish the site if everything looks good.' },
]

const PLUGIN_QUICK_ACTIONS: QuickAction[] = [
  { id: 'create-plugin', label: 'Create plugin', prompt: 'Create a new plugin. I will describe the functionality.' },
  { id: 'add-hook', label: 'Add hook', prompt: 'Add a lifecycle hook to the current plugin. I will describe what it should do.' },
]

const QUICK_ACTIONS_MAP: Record<QuickActionsScope, QuickAction[]> = {
  site: SITE_QUICK_ACTIONS,
  content: CONTENT_QUICK_ACTIONS,
  data: DATA_QUICK_ACTIONS,
  plugin: PLUGIN_QUICK_ACTIONS,
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function QuickActions({ scope, visible, onSelect }: QuickActionsProps) {
  if (!visible) return null

  const actions = QUICK_ACTIONS_MAP[scope] ?? SITE_QUICK_ACTIONS

  return (
    <div className={styles.quickActions}>
      {actions.map((action) => (
        <Button
          key={action.id}
          type="button"
          variant="ghost"
          size="micro"
          shape="pill"
          onClick={() => onSelect(action.prompt)}
        >
          {action.label}
        </Button>
      ))}
    </div>
  )
}
