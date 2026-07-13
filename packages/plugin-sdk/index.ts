/**
 * @instatic/plugin-sdk — public entry point for plugin authors.
 *
 * This package is a thin wrapper that re-exports the host's plugin SDK
 * source (lives in `src/core/plugin-sdk/`). Plugin authors install this
 * package via the workspace, write their plugin code, and the host's
 * build CLI bundles their entrypoint into a `.tgz` that the admin UI
 * uploads.
 *
 * Re-exports mirror `src/core/plugin-sdk/index.ts` exactly.
 */

export * from '../../src/core/plugin-sdk/types'
export * from '../../src/core/plugin-sdk/storageSchemas'
export * from '../../src/core/plugin-sdk/contentSchemas'
export * from '../../src/core/plugin-sdk/capabilities'
export * from '../../src/core/plugin-sdk/guards'
export * from '../../src/core/plugin-sdk/modules'
export * from '../../src/core/plugin-sdk/builders'