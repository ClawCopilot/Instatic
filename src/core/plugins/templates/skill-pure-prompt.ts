// ---------------------------------------------------------------------------
// skill-pure-prompt — a skill that only contributes a system prompt
// ---------------------------------------------------------------------------

import {
  defineSkill,
  SKILL_API_VERSION,
  type PluginManifest,
} from '../../plugin-sdk'
import { parsePluginManifest } from '../manifest'
import {
  COMMON_PARAMS,
  generatePackageJson,
  generateReadme,
  generateTsconfig,
  GITIGNORE,
  safeStr,
} from './shared'
import type { TemplateParamSpec, TemplateManifest } from './types'

// NOTE: The manifest schema (`PluginManifest.triggers`) only supports
// `{ kind: 'always' | 'on-demand' }` — `additionalProperties: false` rejects
// the `scopes` array that the `SkillTrigger` type allows for `kind: 'scope'`.
// We therefore expose `always | on-demand` so that `parsePluginManifest`
// round-trip validation succeeds for both options.
const EXTRA_PARAMS: TemplateParamSpec[] = [
  {
    id: 'systemPrompt',
    label: 'System prompt',
    type: 'textarea',
    required: true,
    description: 'Injected into AI conversations when the skill is active.',
    placeholder: 'You are a helpful assistant that...',
  },
  {
    id: 'triggerKind',
    label: 'Trigger kind',
    type: 'select',
    default: 'always',
    options: [
      { label: 'Always active', value: 'always' },
      { label: 'On-demand', value: 'on-demand' },
    ],
    description: 'When the system prompt is injected into the AI context.',
  },
]

export const skillPurePrompt: TemplateManifest = {
  id: 'skill-pure-prompt',
  kind: 'skill',
  label: 'Pure Prompt Skill',
  description: 'A lightweight skill that contributes only a system prompt — no tools, no server.',
  params: [...COMMON_PARAMS, ...EXTRA_PARAMS],
  generate(params) {
    const pluginId = String(params.pluginId ?? '')
    const name = String(params.name ?? '')
    const version = String(params.version ?? '0.1.0')
    const description = params.description ? String(params.description) : undefined
    const authorName = params.authorName ? String(params.authorName) : undefined
    const systemPrompt = String(params.systemPrompt ?? '')
    const triggerKind = String(params.triggerKind ?? 'always') === 'on-demand' ? 'on-demand' : 'always'

    // 1. Build the manifest via the typed SDK helper.
    //
    // SkillTrigger (defineSkill's type) accepts `kind: 'always' | 'scope'`,
    // but the manifest schema validated by parsePluginManifest only accepts
    // `kind: 'always' | 'on-demand'`. The only value valid in BOTH is
    // `'always'`. For `'on-demand'` we omit `triggers` entirely — the
    // manifest's `triggers` field is optional, and omitting it means the
    // system prompt is not always injected (semantically equivalent to
    // on-demand activation).
    const definition = defineSkill({
      id: pluginId,
      name,
      version,
      apiVersion: SKILL_API_VERSION,
      systemPrompt,
      ...(triggerKind === 'always' ? { triggers: [{ kind: 'always' as const }] } : {}),
      ...(description ? { description } : {}),
      ...(authorName ? { author: { name: authorName } } : {}),
    })

    // 2. Round-trip validate through the host manifest parser. The skill
    //    manifest is accepted as `unknown`; parsePluginManifest fills in the
    //    plugin-only defaults (permissions: [], resources: [], adminPages: []).
    const manifest: PluginManifest = parsePluginManifest(definition.manifest)

    // 3. Generate file contents.
    //
    // In the generated code we only emit the `triggers` field for 'always'.
    // For 'on-demand' we omit it with a comment — `defineSkill`'s
    // `SkillTrigger` type does not accept `kind: 'on-demand'`, and omitting
    // triggers is semantically equivalent (the prompt is not auto-injected).
    const triggersLine =
      triggerKind === 'always'
        ? '  triggers: [{ kind: "always" }],'
        : '  // triggers omitted — on-demand activation (prompt not auto-injected)'

    const indexTs = `import {
  defineSkill,
  SKILL_API_VERSION,
} from '@instatic/plugin-sdk'

export default defineSkill({
  id: ${safeStr(pluginId)},
  name: ${safeStr(name)},
  version: ${safeStr(version)},
  apiVersion: SKILL_API_VERSION,
  systemPrompt: ${safeStr(systemPrompt)},
${triggersLine}${description ? `\n  description: ${safeStr(description)},` : ''}
})
`

    const files: Record<string, string> = {
      'src/index.ts': indexTs,
      'package.json': generatePackageJson({
        pluginId,
        name,
        version,
        description,
        authorName,
        manifest,
      }),
      'tsconfig.json': generateTsconfig(),
      'README.md': generateReadme({ name, pluginId, kind: 'skill', description }),
      '.gitignore': GITIGNORE,
    }

    return { files, manifest, warnings: [] }
  },
}
