/**
 * Template generator tests — matrix test + SDK compatibility.
 *
 * The matrix test runs every registered template with valid params and
 * verifies the generated project is structurally sound:
 *   - `generate()` does not throw
 *   - the manifest round-trips through `parsePluginManifest()`
 *   - expected files are present (`src/index.ts`, `package.json`)
 *   - `package.json` pins `@instatic/plugin-sdk` as a peer dependency
 *   - the manifest's `apiVersion` matches the current SDK constant
 *
 * The SDK compatibility test verifies that the generated source code
 * references the SDK builders (`definePlugin` / `defineSkill`) or
 * constructs a proper `PluginManifest` — the mechanism that guarantees
 * templates break at compile time when the SDK changes, not at runtime
 * after an upgrade.
 */
import { describe, expect, it } from 'bun:test'
import { parsePluginManifest } from '@core/plugins/manifest'
import { PLUGIN_API_VERSION, SKILL_API_VERSION } from '@core/plugin-sdk'
import { ALL_TEMPLATES, findTemplate } from '@core/plugins/templates'
import type { TemplateManifest } from '@core/plugins/templates'

// ---------------------------------------------------------------------------
// Valid params for each template
// ---------------------------------------------------------------------------

const VALID_PARAMS: Record<string, Record<string, unknown>> = {
  'plugin-minimal': {
    pluginId: 'acme.test',
    name: 'Test Plugin',
    version: '0.1.0',
  },
  'plugin-admin-page': {
    pluginId: 'acme.admin',
    name: 'Admin Page',
    version: '0.1.0',
    adminPageKind: 'markdown',
    adminPageTitle: 'Overview',
  },
  'plugin-routes': {
    pluginId: 'acme.routes',
    name: 'Routes Plugin',
    version: '0.1.0',
    resourceId: 'items',
    resourceTitle: 'Items',
  },
  'skill-pure-prompt': {
    pluginId: 'acme.prompt',
    name: 'Prompt Skill',
    version: '0.1.0',
    systemPrompt: 'You are a helpful assistant.',
    triggerKind: 'always',
  },
  'skill-ai-tools': {
    pluginId: 'acme.tools',
    name: 'Tools Skill',
    version: '0.1.0',
    toolName: 'process_content',
    toolDescription: 'Process the provided content.',
  },
  'skill-server-handler': {
    pluginId: 'acme.handler',
    name: 'Handler Skill',
    version: '0.1.0',
    toolName: 'fetch_data',
    toolDescription: 'Fetch data from an external API.',
    needsNetwork: true,
    networkHosts: ['api.example.com'],
  },
}

// ---------------------------------------------------------------------------
// Matrix test — every template produces valid output
// ---------------------------------------------------------------------------

describe('template generator matrix', () => {
  // Sanity: ensure we have test params for every registered template
  it('covers every registered template', () => {
    for (const tmpl of ALL_TEMPLATES) {
      expect(VALID_PARAMS[tmpl.id]).toBeDefined()
    }
  })

  for (const tmpl of ALL_TEMPLATES) {
    describe(`${tmpl.id} (${tmpl.kind})`, () => {
      const params = VALID_PARAMS[tmpl.id]
      let generated: ReturnType<TemplateManifest['generate']>

      it('generate() does not throw', () => {
        expect(() => {
          generated = tmpl.generate(params)
        }).not.toThrow()
      })

      it('manifest round-trips through parsePluginManifest', () => {
        generated = tmpl.generate(params)
        // This is the critical compatibility guarantee: the manifest
        // produced by the template MUST be accepted by the host's
        // manifest parser. If the SDK schema changes and the template
        // hasn't been updated, this assertion fails.
        const reparsed = parsePluginManifest(JSON.parse(JSON.stringify(generated.manifest)))
        expect(reparsed.id).toBe(params.pluginId)
        expect(reparsed.name).toBe(params.name)
        expect(reparsed.version).toBe(params.version)
      })

      it('manifest apiVersion matches current SDK constant', () => {
        generated = tmpl.generate(params)
        const expectedApiVersion = tmpl.kind === 'skill' ? SKILL_API_VERSION : PLUGIN_API_VERSION
        expect(generated.manifest.apiVersion).toBe(expectedApiVersion)
      })

      it('includes src/index.ts in generated files', () => {
        generated = tmpl.generate(params)
        expect(generated.files['src/index.ts']).toBeDefined()
        expect(typeof generated.files['src/index.ts']).toBe('string')
      })

      it('includes package.json with SDK peer dependency', () => {
        generated = tmpl.generate(params)
        const pkgJson = generated.files['package.json']
        expect(pkgJson).toBeDefined()
        const pkg = JSON.parse(pkgJson)
        expect(pkg.peerDependencies).toBeDefined()
        expect(pkg.peerDependencies['@instatic/plugin-sdk']).toBeDefined()
      })

      it('includes tsconfig.json', () => {
        generated = tmpl.generate(params)
        expect(generated.files['tsconfig.json']).toBeDefined()
      })

      it('includes README.md', () => {
        generated = tmpl.generate(params)
        expect(generated.files['README.md']).toBeDefined()
      })

      it('includes .gitignore', () => {
        generated = tmpl.generate(params)
        expect(generated.files['.gitignore']).toBeDefined()
      })

      it('manifest has correct kind', () => {
        generated = tmpl.generate(params)
        if (tmpl.kind === 'skill') {
          expect(generated.manifest.kind).toBe('skill')
        } else {
          expect(generated.manifest.kind ?? 'plugin').toBe('plugin')
        }
      })

      it('warnings is an array', () => {
        generated = tmpl.generate(params)
        expect(Array.isArray(generated.warnings)).toBe(true)
      })
    })
  }
})

// ---------------------------------------------------------------------------
// SDK compatibility — generated source references SDK builders
// ---------------------------------------------------------------------------

describe('template SDK compatibility', () => {
  for (const tmpl of ALL_TEMPLATES) {
    describe(`${tmpl.id}`, () => {
      const params = VALID_PARAMS[tmpl.id]

      it('generated source imports from @instatic/plugin-sdk', () => {
        const generated = tmpl.generate(params)
        const indexTs = generated.files['src/index.ts']
        expect(indexTs).toBeDefined()
        expect(indexTs).toContain('@instatic/plugin-sdk')
      })

      it('generated source uses definePlugin or defineSkill or constructs PluginManifest', () => {
        const generated = tmpl.generate(params)
        const indexTs = generated.files['src/index.ts']

        if (tmpl.id === 'skill-server-handler') {
          // This template constructs a PluginManifest directly (because
          // defineSkill doesn't accept permissions/networkAllowedHosts)
          expect(indexTs).toContain('kind:')
          expect(indexTs).toContain('skill')
        } else if (tmpl.kind === 'skill') {
          expect(indexTs).toContain('defineSkill')
        } else {
          expect(indexTs).toContain('definePlugin')
        }
      })

      it('serialized manifest passes parsePluginManifest (plugin.json simulation)', () => {
        const generated = tmpl.generate(params)
        // Simulate what the scaffold handler does: serialize the manifest
        // as plugin.json and re-parse it. This is the exact round-trip
        // the install endpoint performs.
        const pluginJson = JSON.stringify(generated.manifest, null, 2)
        const reparsed = parsePluginManifest(JSON.parse(pluginJson))
        expect(reparsed.id).toBe(params.pluginId)
      })

      it('generated package.json includes instaticManifest', () => {
        const generated = tmpl.generate(params)
        const pkg = JSON.parse(generated.files['package.json'])
        expect(pkg.instaticManifest).toBeDefined()
        expect(pkg.instaticManifest.id).toBe(params.pluginId)
      })
    })
  }
})

// ---------------------------------------------------------------------------
// Registry integrity
// ---------------------------------------------------------------------------

describe('template registry', () => {
  it('ALL_TEMPLATES has 6 templates (3 plugin + 3 skill)', () => {
    expect(ALL_TEMPLATES).toHaveLength(6)
    const pluginCount = ALL_TEMPLATES.filter((t) => t.kind === 'plugin').length
    const skillCount = ALL_TEMPLATES.filter((t) => t.kind === 'skill').length
    expect(pluginCount).toBe(3)
    expect(skillCount).toBe(3)
  })

  it('every template has a unique id', () => {
    const ids = ALL_TEMPLATES.map((t) => t.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('findTemplate returns the correct template', () => {
    for (const tmpl of ALL_TEMPLATES) {
      const found = findTemplate(tmpl.id)
      expect(found).toBe(tmpl)
    }
  })

  it('findTemplate returns undefined for unknown id', () => {
    expect(findTemplate('nonexistent')).toBeUndefined()
  })

  it('every template has at least one required param', () => {
    for (const tmpl of ALL_TEMPLATES) {
      const requiredCount = tmpl.params.filter((p) => p.required).length
      // At minimum, pluginId and name are required via COMMON_PARAMS
      expect(requiredCount).toBeGreaterThanOrEqual(2)
    }
  })
})
