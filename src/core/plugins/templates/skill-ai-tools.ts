// ---------------------------------------------------------------------------
// skill-ai-tools — a skill that contributes AI tools (no server handler)
// ---------------------------------------------------------------------------

import {
  defineSkill,
  SKILL_API_VERSION,
  type PluginManifest,
  type SkillAiTool,
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

const EXTRA_PARAMS: TemplateParamSpec[] = [
  {
    id: 'toolName',
    label: 'Tool name',
    type: 'string',
    default: 'process_content',
    description: 'snake_case name the AI model uses to invoke the tool.',
    placeholder: 'process_content',
  },
  {
    id: 'toolDescription',
    label: 'Tool description',
    type: 'string',
    default: 'Process the provided content.',
    description: 'Short summary shown to the AI model.',
    placeholder: 'Process the provided content.',
  },
]

export const skillAiTools: TemplateManifest = {
  id: 'skill-ai-tools',
  kind: 'skill',
  label: 'AI Tools Skill',
  description: 'A skill that contributes one or more AI tools (declarative, no server handler).',
  params: [...COMMON_PARAMS, ...EXTRA_PARAMS],
  generate(params) {
    const pluginId = String(params.pluginId ?? '')
    const name = String(params.name ?? '')
    const version = String(params.version ?? '0.1.0')
    const description = params.description ? String(params.description) : undefined
    const authorName = params.authorName ? String(params.authorName) : undefined
    const toolName = String(params.toolName ?? 'process_content')
    const toolDescription = String(params.toolDescription ?? 'Process the provided content.')

    // 1. Build the AI tool definition.
    const aiTool: SkillAiTool = {
      name: toolName,
      description: toolDescription,
      inputSchema: {
        type: 'object',
        properties: {
          content: { type: 'string', description: 'The content to process.' },
        },
        required: ['content'],
      },
    }

    const definition = defineSkill({
      id: pluginId,
      name,
      version,
      apiVersion: SKILL_API_VERSION,
      aiTools: [aiTool],
      ...(description ? { description } : {}),
      ...(authorName ? { author: { name: authorName } } : {}),
    })

    // 2. Round-trip validate.
    const manifest: PluginManifest = parsePluginManifest(definition.manifest)

    // 3. Generate file contents.
    const indexTs = `import {
  defineSkill,
  SKILL_API_VERSION,
  type SkillAiTool,
} from '@instatic/plugin-sdk'

const tools: SkillAiTool[] = [
  {
    name: ${safeStr(toolName)},
    description: ${safeStr(toolDescription)},
    inputSchema: {
      type: "object",
      properties: {
        content: { type: "string", description: "The content to process." },
      },
      required: ["content"],
    },
  },
]

export default defineSkill({
  id: ${safeStr(pluginId)},
  name: ${safeStr(name)},
  version: ${safeStr(version)},
  apiVersion: SKILL_API_VERSION,
  aiTools: tools,${description ? `\n  description: ${safeStr(description)},` : ''}
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
