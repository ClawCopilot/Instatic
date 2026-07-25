/**
 * Plugin/skill template scaffolding endpoints.
 *
 *   GET  /admin/api/cms/plugins/templates   — list available templates
 *   POST /admin/api/cms/plugins/scaffold    — generate a project from a template
 *
 * The scaffold endpoint produces source files (and an optional zip archive)
 * that the user can download, review, and install via the normal package
 * install flow. It does NOT install anything — the generated code must go
 * through the standard `POST /admin/api/cms/plugins/package` path with
 * capability + step-up gating before it executes on the host.
 *
 * Deep system integration is guaranteed by construction:
 *  - Every template calls `definePlugin` / `defineSkill` internally, so SDK
 *    type changes surface as compile errors in the template itself.
 *  - Each `generate()` round-trips its manifest through `parsePluginManifest`,
 *    so schema drift is caught at generation time, not at install time.
 *  - The generated `package.json` pins `@instatic/plugin-sdk` as a
 *    `peerDependency`, so the scaffolded project tracks the host's SDK.
 *  - The zip includes a `plugin.json` so the output is directly installable
 *    via `POST /admin/api/cms/plugins/package`.
 */
import { zipSync, strToU8 } from 'fflate'
import { Type } from '@core/utils/typeboxHelpers'
import { badRequest, jsonResponse, methodNotAllowed, readValidatedBody } from '../../../http'
import { getErrorMessage } from '@core/utils/errorMessage'
import { ALL_TEMPLATES, findTemplate } from '@core/plugins/templates'
import type { TemplateParamSpec } from '@core/plugins/templates'

// ---------------------------------------------------------------------------
// Wire types — the serialisable subset of TemplateManifest
// ---------------------------------------------------------------------------

interface TemplateSummary {
  id: string
  kind: 'plugin' | 'skill'
  label: string
  description: string
  params: TemplateParamSpec[]
}

// ---------------------------------------------------------------------------
// GET /admin/api/cms/plugins/templates
// ---------------------------------------------------------------------------

/**
 * List every available template (plugins first, then skills). The response
 * carries each template's metadata + param specs so the admin UI can render
 * a picker and a dynamic form without hardcoding anything.
 *
 * The non-serialisable `generate` function is stripped — callers that want
 * to run it must POST to `/scaffold` with the template id + params.
 */
export async function handleListTemplates(req: Request): Promise<Response> {
  if (req.method !== 'GET') return methodNotAllowed()

  const templates: TemplateSummary[] = ALL_TEMPLATES.map((t) => ({
    id: t.id,
    kind: t.kind,
    label: t.label,
    description: t.description,
    params: t.params,
  }))

  return jsonResponse({ templates })
}

// ---------------------------------------------------------------------------
// POST /admin/api/cms/plugins/scaffold
// ---------------------------------------------------------------------------

const ScaffoldBodySchema = Type.Object({
  templateId: Type.String({ minLength: 1 }),
  params: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
})

/**
 * Generate a project from a template. The request body carries the template
 * id and the user-supplied params; the response is either a JSON envelope
 * (default) or a binary zip archive (`?format=zip`).
 *
 * JSON response:
 *   { templateId, files, manifest, warnings }
 *
 * ZIP response:
 *   Binary zip with `Content-Type: application/zip` and a
 *   `Content-Disposition: attachment` header. The zip includes a
 *   `plugin.json` at the root so it can be installed directly via
 *   `POST /admin/api/cms/plugins/package`.
 */
export async function handleScaffold(req: Request): Promise<Response> {
  if (req.method !== 'POST') return methodNotAllowed()

  const body = await readValidatedBody(req, ScaffoldBodySchema)
  if (!body) return badRequest('Invalid scaffold request body')

  const template = findTemplate(body.templateId)
  if (!template) {
    return badRequest(`Unknown template id: ${body.templateId}`)
  }

  let generated
  try {
    generated = template.generate(body.params ?? {})
  } catch (err) {
    return badRequest(getErrorMessage(err, 'Template generation failed'))
  }

  // Add `plugin.json` to the file set so the zip is directly installable
  // via the package install endpoint. The manifest has already been
  // round-trip validated by the template's `generate()` call.
  const allFiles: Record<string, string> = {
    ...generated.files,
    'plugin.json': JSON.stringify(generated.manifest, null, 2) + '\n',
  }

  const url = new URL(req.url)
  const format = url.searchParams.get('format')

  if (format === 'zip') {
    return buildZipResponse(allFiles, generated.manifest.id)
  }

  return jsonResponse({
    templateId: template.id,
    files: allFiles,
    manifest: generated.manifest,
    warnings: generated.warnings,
  })
}

// ---------------------------------------------------------------------------
// ZIP builder
// ---------------------------------------------------------------------------

/**
 * Build a binary zip response from a set of text files. Every file content
 * is UTF-8 encoded via `strToU8` so non-ASCII source (e.g. CJK comments)
 * round-trips correctly.
 */
function buildZipResponse(files: Record<string, string>, pluginId: string): Response {
  const zippable: Record<string, Uint8Array> = {}
  for (const [path, content] of Object.entries(files)) {
    zippable[path] = strToU8(content)
  }

  const zipBytes = zipSync(zippable, { level: 9 })
  const filename = `${pluginId.replace(/\./g, '-')}.zip`

  const res = new Response(zipBytes.buffer as ArrayBuffer, { status: 200 })
  res.headers.set('content-type', 'application/zip')
  res.headers.set('content-disposition', `attachment; filename="${filename}"`)
  res.headers.set('content-length', String(zipBytes.byteLength))
  return res
}
