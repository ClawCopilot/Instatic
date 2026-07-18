// ---------------------------------------------------------------------------
// Template registry — central catalogue of all available templates
// ---------------------------------------------------------------------------

import { pluginAdminPage } from './plugin-admin-page'
import { pluginMinimal } from './plugin-minimal'
import { pluginRoutes } from './plugin-routes'
import { skillAiTools } from './skill-ai-tools'
import { skillPurePrompt } from './skill-pure-prompt'
import { skillServerHandler } from './skill-server-handler'
import type { TemplateManifest } from './types'

/** All plugin templates, ordered from simplest to most complex. */
export const PLUGIN_TEMPLATES: TemplateManifest[] = [
  pluginMinimal,
  pluginAdminPage,
  pluginRoutes,
]

/** All skill templates, ordered from simplest to most complex. */
export const SKILL_TEMPLATES: TemplateManifest[] = [
  skillPurePrompt,
  skillAiTools,
  skillServerHandler,
]

/** Every available template (plugins first, then skills). */
export const ALL_TEMPLATES: TemplateManifest[] = [
  ...PLUGIN_TEMPLATES,
  ...SKILL_TEMPLATES,
]

/**
 * Look up a template by its unique id.
 * Returns `undefined` when no template matches.
 */
export function findTemplate(id: string): TemplateManifest | undefined {
  return ALL_TEMPLATES.find((t) => t.id === id)
}
