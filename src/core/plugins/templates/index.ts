// ---------------------------------------------------------------------------
// Barrel export for the template generator module
// ---------------------------------------------------------------------------

export type { GeneratedProject, TemplateManifest, TemplateParamSpec } from './types'

export {
  COMMON_PARAMS,
  GITIGNORE,
  generatePackageJson,
  generateReadme,
  generateTsconfig,
  kebab,
  packageName,
  safeStr,
} from './shared'

export { pluginAdminPage } from './plugin-admin-page'
export { pluginMinimal } from './plugin-minimal'
export { pluginRoutes } from './plugin-routes'
export { skillAiTools } from './skill-ai-tools'
export { skillPurePrompt } from './skill-pure-prompt'
export { skillServerHandler } from './skill-server-handler'

export { ALL_TEMPLATES, PLUGIN_TEMPLATES, SKILL_TEMPLATES, findTemplate } from './registry'
