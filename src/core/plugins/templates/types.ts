// ---------------------------------------------------------------------------
// Template generator types
// ---------------------------------------------------------------------------
//
// These types describe the shape of a project template (plugin or skill) and
// the project artefacts it produces. A template declares the parameters it
// needs from the user and a `generate` function that turns those parameters
// into a set of source files plus a validated manifest.

import type { PluginManifest } from '../../plugin-sdk'

/**
 * A single parameter that a template asks the user for.
 *
 * The `type` drives both the UI control rendered in the CLI/VS Code wizard
 * and the coercion applied to the raw value before it is passed to
 * `TemplateManifest.generate`.
 */
export interface TemplateParamSpec {
  /** Stable id used as the key in the params record. */
  id: string
  /** Human-readable label shown next to the input. */
  label: string
  /** Input control kind. */
  type: 'string' | 'boolean' | 'select' | 'string[]' | 'textarea'
  /** When true the wizard refuses to continue until a value is provided. */
  required?: boolean
  /** Default value used when the user skips the prompt. */
  default?: string | boolean | string[]
  /** Only valid for `type: 'select'`. */
  options?: Array<{ label: string; value: string }>
  /** Help text shown under the input. */
  description?: string
  /** Placeholder shown inside the input when empty. */
  placeholder?: string
}

/**
 * The output of a template `generate` call.
 *
 * `files` maps relative paths (POSIX, forward slashes) to file contents.
 * `manifest` is the round-trip validated plugin manifest — it has been
 * produced by `definePlugin` / `defineSkill` (or constructed directly) and
 * then re-parsed with `parsePluginManifest` so that every optional field
 * carries its normalised default.
 */
export interface GeneratedProject {
  files: Record<string, string>
  manifest: PluginManifest
  /** Non-fatal issues the user should be aware of (e.g. skipped validation). */
  warnings: string[]
}

/**
 * Descriptor for a single template.
 */
export interface TemplateManifest {
  /** Unique id, e.g. `plugin-minimal`. */
  id: string
  /** Whether this template scaffolds a plugin or a skill. */
  kind: 'plugin' | 'skill'
  /** Short label shown in the template picker. */
  label: string
  /** One-line description shown under the label. */
  description: string
  /** Parameters the user must supply. */
  params: TemplateParamSpec[]
  /** Turns user params into a generated project. */
  generate: (params: Record<string, unknown>) => GeneratedProject
}
