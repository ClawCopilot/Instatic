// ---------------------------------------------------------------------------
// skill-server-handler — a skill with a server entrypoint + network access
// ---------------------------------------------------------------------------
//
// Unlike the other two skill templates this one CANNOT use `defineSkill()`
// because the resulting SkillManifest does not carry `permissions`,
// `networkAllowedHosts`, or `entrypoints`. We therefore construct a
// `PluginManifest` object literal with `kind: 'skill'` directly and validate
// it through `parsePluginManifest`.

import {
  SKILL_API_VERSION,
  permissions,
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

const EXTRA_PARAMS: TemplateParamSpec[] = [
  {
    id: 'toolName',
    label: 'Tool name',
    type: 'string',
    default: 'fetch_data',
    description: 'snake_case name the AI model uses to invoke the tool.',
    placeholder: 'fetch_data',
  },
  {
    id: 'toolDescription',
    label: 'Tool description',
    type: 'string',
    default: 'Fetch data from an external API.',
    description: 'Short summary shown to the AI model.',
    placeholder: 'Fetch data from an external API.',
  },
  {
    id: 'needsNetwork',
    label: 'Needs network access',
    type: 'boolean',
    default: true,
    description: 'When true the skill requests the network.outbound permission.',
  },
  {
    id: 'networkHosts',
    label: 'Allowed network hosts',
    type: 'string[]',
    default: ['api.example.com'],
    description: 'Outbound hosts the skill may call (require network access).',
  },
]

export const skillServerHandler: TemplateManifest = {
  id: 'skill-server-handler',
  kind: 'skill',
  label: 'Server Handler Skill',
  description: 'A skill with a server entrypoint, AI tools, and optional network access.',
  params: [...COMMON_PARAMS, ...EXTRA_PARAMS],
  generate(params) {
    const pluginId = String(params.pluginId ?? '')
    const name = String(params.name ?? '')
    const version = String(params.version ?? '0.1.0')
    const description = params.description ? String(params.description) : undefined
    const authorName = params.authorName ? String(params.authorName) : undefined
    const toolName = String(params.toolName ?? 'fetch_data')
    const toolDescription = String(params.toolDescription ?? 'Fetch data from an external API.')
    const needsNetwork = params.needsNetwork !== false
    const networkHosts = Array.isArray(params.networkHosts)
      ? params.networkHosts.filter((h): h is string => typeof h === 'string')
      : ['api.example.com']

    // 1. Construct the manifest object literal directly. defineSkill() cannot
    //    carry permissions / networkAllowedHosts / entrypoints, so we build a
    //    full PluginManifest with kind: 'skill'.
    const rawManifest: PluginManifest = {
      kind: 'skill',
      id: pluginId,
      name,
      version,
      apiVersion: SKILL_API_VERSION,
      permissions: needsNetwork ? [permissions.networkOutbound] : [],
      resources: [],
      adminPages: [],
      entrypoints: { server: 'dist/index.js' },
      aiTools: [
        {
          name: toolName,
          description: toolDescription,
          inputSchema: {
            type: 'object',
            properties: {
              url: { type: 'string', description: 'URL to fetch' },
            },
            required: ['url'],
          },
        },
      ],
      ...(needsNetwork ? { networkAllowedHosts: networkHosts } : {}),
      ...(description ? { description } : {}),
      ...(authorName ? { author: { name: authorName } } : {}),
    }

    // 2. Round-trip validate.
    const manifest: PluginManifest = parsePluginManifest(rawManifest)

    // 3. Generate file contents.
    const indexTs = generateIndexTs({
      pluginId,
      name,
      version,
      description,
      toolName,
      toolDescription,
      needsNetwork,
      networkHosts,
    })

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

interface IndexTsOpts {
  pluginId: string
  name: string
  version: string
  description?: string
  toolName: string
  toolDescription: string
  needsNetwork: boolean
  networkHosts: string[]
}

function generateIndexTs(opts: IndexTsOpts): string {
  const permLine = opts.needsNetwork
    ? '  permissions: [permissions.networkOutbound],'
    : '  permissions: [],'
  const networkLine = opts.needsNetwork
    ? `  networkAllowedHosts: ${JSON.stringify(opts.networkHosts)},`
    : undefined
  // Only import `permissions` when it is actually referenced.
  const permissionsImport = opts.needsNetwork ? '  permissions,' : undefined

  // Use `undefined` for conditionally-omitted lines so the filter below
  // removes them without dropping intentional blank lines (`''`).
  const lines: Array<string | undefined> = [
    'import {',
    '  SKILL_API_VERSION,',
    permissionsImport,
    "  type PluginManifest,",
    '  type ServerPluginApi,',
    "  type ServerPluginModule,",
    "} from '@instatic/plugin-sdk'",
    '',
    'const manifest: PluginManifest = {',
    `  kind: ${safeStr('skill')},`,
    `  id: ${safeStr(opts.pluginId)},`,
    `  name: ${safeStr(opts.name)},`,
    `  version: ${safeStr(opts.version)},`,
    '  apiVersion: SKILL_API_VERSION,',
    permLine,
    networkLine,
    '  entrypoints: { server: "dist/index.js" },',
    '  resources: [],',
    '  adminPages: [],',
    '  aiTools: [',
    '    {',
    `      name: ${safeStr(opts.toolName)},`,
    `      description: ${safeStr(opts.toolDescription)},`,
    '      inputSchema: {',
    '        type: "object",',
    '        properties: {',
    '          url: { type: "string", description: "URL to fetch" },',
    '        },',
    '        required: ["url"],',
    '      },',
    '    },',
    '  ],',
    opts.description ? `  description: ${safeStr(opts.description)},` : undefined,
    '}',
    '',
    'export default manifest',
    '',
    "export const activate: ServerPluginModule['activate'] = async (api: ServerPluginApi) => {",
    `  api.plugin.log(${safeStr('Skill server handler activated')})`,
    '}',
    '',
  ]

  return lines.filter((line): line is string => line !== undefined).join('\n')
}
