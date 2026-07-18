// ---------------------------------------------------------------------------
// Shared helpers used by every template generator
// ---------------------------------------------------------------------------

import type { PluginManifest } from '../../plugin-sdk'
import type { TemplateParamSpec } from './types'

/**
 * Escape a user-provided string so it can be safely embedded inside generated
 * TypeScript source as a double-quoted string literal. Uses `JSON.stringify`
 * so all special characters (quotes, backslashes, newlines, control chars)
 * are correctly escaped.
 *
 *   safeStr('hello')        → '"hello"'
 *   safeStr('he"llo')       → '"he\\"llo"'
 *   safeStr('line\nbreak')  → '"line\\nbreak"'
 */
export function safeStr(s: string): string {
  return JSON.stringify(s)
}

/**
 * Derive a kebab-case package-name tail from a plugin id.
 *
 *   kebab('acme.my-plugin')  → 'my-plugin'
 *   kebab('acme.foo.bar')    → 'foo-bar'
 *   kebab('standalone')      → 'standalone'
 *
 * Everything after the first dot is kept; remaining dots become dashes.
 */
export function kebab(pluginId: string): string {
  const parts = pluginId.split('.')
  if (parts.length <= 1) return pluginId
  return parts.slice(1).join('-')
}

/**
 * Derive a scoped npm package name from a plugin id.
 *
 *   packageName('acme.my-plugin') → '@acme/my-plugin'
 */
export function packageName(pluginId: string): string {
  const [vendor, ...rest] = pluginId.split('.')
  const tail = rest.length > 0 ? rest.join('-') : pluginId
  return `@${vendor}/${tail}`
}

// ---------------------------------------------------------------------------
// package.json
// ---------------------------------------------------------------------------

export interface PackageJsonOpts {
  pluginId: string
  name: string
  version: string
  description?: string
  authorName?: string
  /** Validated manifest embedded as `instaticManifest`. */
  manifest: PluginManifest
}

/**
 * Generate a `package.json` string for a scaffolded plugin/skill project.
 */
export function generatePackageJson(opts: PackageJsonOpts): string {
  const pkg: Record<string, unknown> = {
    name: packageName(opts.pluginId),
    version: opts.version,
    description: opts.description ?? '',
    main: 'src/index.ts',
    type: 'module',
    scripts: {
      build: 'bun build src/index.ts --target=bun --outdir=dist --external @instatic/*',
      typecheck: 'tsc --noEmit',
    },
    peerDependencies: {
      '@instatic/plugin-sdk': '^1.0.0',
    },
    instaticManifest: opts.manifest,
  }
  if (opts.authorName) {
    pkg.author = opts.authorName
  }
  return JSON.stringify(pkg, null, 2) + '\n'
}

// ---------------------------------------------------------------------------
// tsconfig.json
// ---------------------------------------------------------------------------

/**
 * Generate a `tsconfig.json` string for a scaffolded plugin/skill project.
 * The project extends the SDK's base config and resolves
 * `@instatic/plugin-sdk` to the workspace source for type-checking.
 */
export function generateTsconfig(): string {
  const tsconfig = {
    extends: '../../packages/plugin-sdk/tsconfig.base.json',
    compilerOptions: {
      noEmit: true,
      strict: true,
      skipLibCheck: true,
      module: 'esnext',
      moduleResolution: 'bundler',
      target: 'esnext',
      lib: ['esnext', 'dom'],
      types: ['bun'],
      paths: {
        '@instatic/plugin-sdk': ['./../../packages/plugin-sdk/index.ts'],
        '@instatic/plugin-sdk/*': ['./../../packages/plugin-sdk/src/*'],
      },
    },
    include: ['src/**/*.ts'],
  }
  return JSON.stringify(tsconfig, null, 2) + '\n'
}

// ---------------------------------------------------------------------------
// README.md
// ---------------------------------------------------------------------------

export interface ReadmeOpts {
  name: string
  pluginId: string
  kind: 'plugin' | 'skill'
  description?: string
}

/**
 * Generate a `README.md` string for a scaffolded plugin/skill project.
 */
export function generateReadme(opts: ReadmeOpts): string {
  const lines: string[] = [
    `# ${opts.name}`,
    '',
    `> ${opts.kind === 'skill' ? 'Skill' : 'Plugin'} id: \`${opts.pluginId}\``,
    '',
  ]
  if (opts.description) {
    lines.push(opts.description, '')
  }
  lines.push(
    '## Develop',
    '',
    '```bash',
    'bun install',
    'bun run typecheck',
    'bun run build',
    '```',
    '',
  )
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// .gitignore
// ---------------------------------------------------------------------------

export const GITIGNORE = [
  'node_modules',
  'dist',
  '*.plugin.zip',
  '.DS_Store',
  '',
].join('\n')

// ---------------------------------------------------------------------------
// Common params
// ---------------------------------------------------------------------------

/**
 * Parameters shared by every template. Each template spreads these and then
 * appends its own extra params.
 */
export const COMMON_PARAMS: TemplateParamSpec[] = [
  {
    id: 'pluginId',
    label: 'Plugin ID',
    type: 'string',
    required: true,
    description: 'Namespaced as <vendor>.<name>, e.g. acme.my-plugin.',
    placeholder: 'acme.my-plugin',
  },
  {
    id: 'name',
    label: 'Display name',
    type: 'string',
    required: true,
    placeholder: 'My Plugin',
  },
  {
    id: 'version',
    label: 'Version',
    type: 'string',
    required: true,
    default: '0.1.0',
    placeholder: '0.1.0',
  },
  {
    id: 'description',
    label: 'Description',
    type: 'textarea',
    required: false,
    placeholder: 'A short description shown on the plugin card.',
  },
  {
    id: 'authorName',
    label: 'Author name',
    type: 'string',
    required: false,
    placeholder: 'Your name or organisation',
  },
]
