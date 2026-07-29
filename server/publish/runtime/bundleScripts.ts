import { createRequire } from 'node:module'
import { dirname, join, posix, relative, sep } from 'node:path'
import * as esbuild from 'esbuild'
import type { Page, SiteDocument } from '@core/page-tree'
import {
  analyzeRuntimeScriptImports,
  collectRuntimeScripts,
  normalizeSiteRuntimeConfig,
} from '@core/site-runtime'
import type {
  PublishedPageRuntimeAssets,
  PublishedRuntimeScriptAsset,
  RuntimeScriptEntry,
  SiteRuntimeDiagnostic,
  SiteRuntimeTarget,
} from '@core/site-runtime'
import {
  clonePackageJson,
  DEFAULT_SITE_PACKAGE_JSON,
} from '@core/site-dependencies/manifest'
import type { RuntimeDependencyCache } from './dependencyCache'

export interface BuiltRuntimeAssetFile {
  path: string
  publicPath: string
  content: string
  bytes: Uint8Array
  contentType: string
}

export interface SiteRuntimeBuildResult {
  files: BuiltRuntimeAssetFile[]
  runtimeAssets: PublishedPageRuntimeAssets
  diagnostics: SiteRuntimeDiagnostic[]
}

export interface BuildSiteRuntimeScriptsInput {
  site: SiteDocument
  page: Page
  target: SiteRuntimeTarget
  assetBasePath: string
  dependencyCache?: Pick<RuntimeDependencyCache, 'nodeModulesDir'>
  dependencyNodeModulesDir?: string
  /** Override the bundle timeout (ms). Mainly for tests. */
  bundleTimeoutMs?: number
}

/**
 * Hard upper bound on the time a single esbuild invocation may run.
 * Pathological imports or very large script trees should fail fast rather
 * than tying up server capacity indefinitely.
 */
const DEFAULT_BUNDLE_TIMEOUT_MS = 30_000
const textEncoder = new TextEncoder()
const SITE_MODULE_PREFIX = 'instatic-site:'
const SITE_MODULE_NAMESPACE = 'instatic-site'

function toPosixPath(path: string): string {
  return path.split(sep).join('/')
}

function joinPublicPath(basePath: string, path: string): string {
  const base = basePath.endsWith('/') ? basePath : `${basePath}/`
  return `${base}${path.replace(/^\/+/, '')}`
}

function contentTypeForPath(path: string): string {
  if (path.endsWith('.js')) return 'text/javascript; charset=utf-8'
  if (path.endsWith('.css')) return 'text/css; charset=utf-8'
  if (path.endsWith('.map')) return 'application/json; charset=utf-8'
  return 'application/octet-stream'
}

function scriptFormat(entry: RuntimeScriptEntry): 'module' | 'classic' {
  return entry.config.format === 'classic' ? 'classic' : 'module'
}

function safeOutputFileName(path: string): string {
  const base = path.split('/').pop() ?? 'script.js'
  const safe = base.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
  if (!safe) return 'script.js'
  return safe.endsWith('.js') ? safe : `${safe}.js`
}

function uniqueClassicOutputPath(
  entry: RuntimeScriptEntry,
  index: number,
  usedPaths: Set<string>,
): string {
  const base = `${String(index + 1).padStart(3, '0')}-${safeOutputFileName(entry.file.path)}`
  let path = `classic/${base}`
  let suffix = 2
  while (usedPaths.has(path)) {
    path = `classic/${base.replace(/\.js$/, '')}-${suffix}.js`
    suffix += 1
  }
  usedPaths.add(path)
  return path
}

function buildClassicRuntimeFiles(
  scripts: RuntimeScriptEntry[],
  assetBasePath: string,
): { files: BuiltRuntimeAssetFile[]; assets: PublishedRuntimeScriptAsset[] } {
  const usedPaths = new Set<string>()
  const files: BuiltRuntimeAssetFile[] = []
  const assets: PublishedRuntimeScriptAsset[] = []

  for (const [index, script] of scripts.entries()) {
    const content = script.file.content ?? ''
    const path = uniqueClassicOutputPath(script, index, usedPaths)
    const publicPath = joinPublicPath(assetBasePath, path)
    files.push({
      path,
      publicPath,
      content,
      bytes: textEncoder.encode(content),
      contentType: contentTypeForPath(path),
    })
    assets.push({
      fileId: script.file.id,
      src: publicPath,
      format: 'classic',
      placement: script.config.placement,
      timing: script.config.timing,
      priority: script.config.priority,
    })
  }

  return { files, assets }
}

function emptyRuntimeBuild(diagnostics: SiteRuntimeDiagnostic[] = []): SiteRuntimeBuildResult {
  return {
    files: [],
    runtimeAssets: { scripts: [] },
    diagnostics,
  }
}

function esbuildDiagnostics(error: unknown): SiteRuntimeDiagnostic[] {
  if (
    error &&
    typeof error === 'object' &&
    'errors' in error &&
    Array.isArray((error as { errors: unknown }).errors)
  ) {
    return (error as { errors: Array<{ text?: string; location?: { file?: string; line?: number; column?: number } }> }).errors
      .map((item) => ({
        code: 'runtime-bundle-error',
        severity: 'error' as const,
        message: item.text ?? 'Runtime script bundle failed',
        path: item.location?.file,
        line: item.location?.line,
        column: item.location?.column,
      }))
  }

  return [{
    code: 'runtime-bundle-error',
    severity: 'error',
    message: error instanceof Error ? error.message : 'Runtime script bundle failed',
  }]
}

function selectedScriptByEntryPoint(
  selectedScripts: RuntimeScriptEntry[],
): Map<string, RuntimeScriptEntry> {
  const entries = new Map<string, RuntimeScriptEntry>()
  for (const script of selectedScripts) {
    const path = normalizeSiteModulePath(script.file.path)
    entries.set(`${SITE_MODULE_PREFIX}${path}`, script)
    entries.set(path, script)
  }
  return entries
}

function normalizeSiteModulePath(path: string): string {
  return posix.normalize(path.replaceAll('\\', '/')).replace(/^\.\/+/, '')
}

function siteModuleLoader(path: string): esbuild.Loader {
  if (path.endsWith('.tsx')) return 'tsx'
  if (path.endsWith('.jsx')) return 'jsx'
  if (path.endsWith('.json')) return 'json'
  if (path.endsWith('.css')) return 'css'
  if (path.endsWith('.js') || path.endsWith('.mjs') || path.endsWith('.cjs')) return 'js'
  return 'ts'
}

function localModuleCandidates(importer: string, specifier: string): string[] {
  const requested = normalizeSiteModulePath(
    specifier.startsWith('/')
      ? specifier.slice(1)
      : posix.join(posix.dirname(importer), specifier),
  )
  const candidates = [requested]
  if (!posix.extname(requested)) {
    candidates.push(
      `${requested}.ts`,
      `${requested}.tsx`,
      `${requested}.js`,
      `${requested}.jsx`,
      `${requested}.json`,
      posix.join(requested, 'index.ts'),
      posix.join(requested, 'index.tsx'),
      posix.join(requested, 'index.js'),
      posix.join(requested, 'index.jsx'),
    )
  } else if (requested.endsWith('.js')) {
    candidates.push(requested.slice(0, -3) + '.ts', requested.slice(0, -3) + '.tsx')
  } else if (requested.endsWith('.jsx')) {
    candidates.push(requested.slice(0, -4) + '.ts', requested.slice(0, -4) + '.tsx')
  }
  return candidates
}

function isWithinDirectory(rootDir: string, path: string): boolean {
  const relativePath = relative(rootDir, path)
  return relativePath === '' || (!relativePath.startsWith('..') && !relativePath.startsWith(sep))
}

function resolveRuntimeDependency(
  specifier: string,
  importer: string,
  dependencyNodeModulesDirs: string[],
): string | null {
  const anchors = [
    ...(importer ? [importer] : []),
    ...dependencyNodeModulesDirs.map((nodeModulesDir) => join(dirname(nodeModulesDir), 'package.json')),
  ]

  for (const anchor of anchors) {
    try {
      const resolved = createRequire(anchor).resolve(specifier)
      if (
        dependencyNodeModulesDirs.some((nodeModulesDir) => (
          isWithinDirectory(nodeModulesDir, resolved)
        ))
      ) {
        return resolved
      }
    } catch {
      // Try the next explicitly configured dependency cache.
    }
  }
  return null
}

function createSiteModulePlugin(
  site: SiteDocument,
  dependencyNodeModulesDirs: string[],
): esbuild.Plugin {
  const sourceByPath = new Map(
    site.files
      .filter((file) => file.type === 'script' && typeof file.content === 'string')
      .map((file) => [normalizeSiteModulePath(file.path), file.content ?? '']),
  )

  return {
    name: 'instatic-site-modules',
    setup(build) {
      build.onResolve({ filter: /^instatic-site:/ }, (args) => {
        const path = normalizeSiteModulePath(args.path.slice(SITE_MODULE_PREFIX.length))
        return sourceByPath.has(path)
          ? { path, namespace: SITE_MODULE_NAMESPACE }
          : { errors: [{ text: `Could not resolve site module "${path}"` }] }
      })

      build.onResolve({ filter: /.*/, namespace: SITE_MODULE_NAMESPACE }, async (args) => {
        if (args.path.startsWith('.') || args.path.startsWith('/')) {
          const path = localModuleCandidates(args.importer, args.path)
            .find((candidate) => sourceByPath.has(candidate))
          return path
            ? { path, namespace: SITE_MODULE_NAMESPACE }
            : { errors: [{ text: `Could not resolve "${args.path}" from "${args.importer}"` }] }
        }

        const path = resolveRuntimeDependency(args.path, '', dependencyNodeModulesDirs)
        return path
          ? { path }
          : {
              errors: [{
                text: `Could not resolve runtime dependency "${args.path}" from the dependency cache`,
              }],
            }
      })

      build.onResolve({ filter: /^[^./]/, namespace: 'file' }, (args) => {
        const path = resolveRuntimeDependency(args.path, args.importer, dependencyNodeModulesDirs)
        return path
          ? { path }
          : {
              errors: [{
                text: `Could not resolve runtime dependency "${args.path}" from the dependency cache`,
              }],
            }
      })

      build.onLoad({ filter: /.*/, namespace: SITE_MODULE_NAMESPACE }, (args) => ({
        contents: sourceByPath.get(args.path) ?? '',
        loader: siteModuleLoader(args.path),
      }))
    },
  }
}

export async function buildSiteRuntimeScripts(
  input: BuildSiteRuntimeScriptsInput,
): Promise<SiteRuntimeBuildResult> {
  const runtime = normalizeSiteRuntimeConfig(input.site.runtime)
  const selectedScripts = collectRuntimeScripts({
    files: input.site.files,
    runtime,
    page: input.page,
    target: input.target,
  })

  if (selectedScripts.length === 0) return emptyRuntimeBuild()

  const moduleScripts = selectedScripts.filter((entry) => scriptFormat(entry) === 'module')
  const classicScripts = selectedScripts.filter((entry) => scriptFormat(entry) === 'classic')
  const classicBuild = buildClassicRuntimeFiles(classicScripts, input.assetBasePath)

  const packageJson = clonePackageJson(input.site.packageJson ?? DEFAULT_SITE_PACKAGE_JSON)
  const importAnalysis = analyzeRuntimeScriptImports(
    moduleScripts.map((entry) => entry.file),
    packageJson,
  )
  const blockingDiagnostics = importAnalysis.diagnostics.filter((diagnostic) => diagnostic.severity === 'error')
  if (blockingDiagnostics.length > 0) return emptyRuntimeBuild(importAnalysis.diagnostics)

  if (moduleScripts.length === 0) {
    return {
      files: classicBuild.files,
      runtimeAssets: { scripts: classicBuild.assets },
      diagnostics: importAnalysis.diagnostics,
    }
  }

  const dependencyNodeModulesDirs = [
    ...(input.dependencyCache?.nodeModulesDir ? [input.dependencyCache.nodeModulesDir] : []),
    ...(input.dependencyNodeModulesDir ? [input.dependencyNodeModulesDir] : []),
  ]
  try {
    const entryPoints = moduleScripts
      .map((entry) => `${SITE_MODULE_PREFIX}${normalizeSiteModulePath(entry.file.path)}`)

    if (entryPoints.length === 0) {
      return {
        files: classicBuild.files,
        runtimeAssets: { scripts: classicBuild.assets },
        diagnostics: importAnalysis.diagnostics,
      }
    }

    const outputRoot = 'out'
    const splitRuntimeChunks = input.target === 'publish'
    // For `bundleTimeoutMs <= 0` we short-circuit before esbuild starts. A
    // `setTimeout(0)` race against a microtask-scheduled promise is
    // non-deterministic, and abandoning a live esbuild promise can surface as
    // an unhandled rejection after the temp workspace is cleaned up.
    const bundleTimeoutMs = input.bundleTimeoutMs ?? DEFAULT_BUNDLE_TIMEOUT_MS
    if (bundleTimeoutMs <= 0) {
      throw new Error(`runtime bundle timed out after ${bundleTimeoutMs}ms`)
    }

    const buildPromise = esbuild.build({
      absWorkingDir: process.cwd(),
      assetNames: 'assets/[name]-[hash]',
      bundle: true,
      chunkNames: 'chunks/[name]-[hash]',
      entryNames: 'entries/[name]-[hash]',
      entryPoints,
      format: 'esm',
      logLevel: 'silent',
      metafile: true,
      nodePaths: dependencyNodeModulesDirs,
      outdir: outputRoot,
      platform: 'browser',
      plugins: [createSiteModulePlugin(input.site, dependencyNodeModulesDirs)],
      // Inline source maps for canvas preview keep runtime errors mappable
      // back to user code without serving separate .map assets. Publish
      // output stays minimal — the published surface is read-only and we
      // would otherwise emit map files that no one consumes.
      sourcemap: input.target === 'canvas' ? 'inline' : false,
      splitting: splitRuntimeChunks,
      target: ['es2020'],
      // Site scripts live in an isolated virtual workspace and must not
      // inherit a host project's tsconfig. Supplying an explicit empty config
      // also prevents esbuild from walking parent directories outside the
      // runtime sandbox while searching for one.
      tsconfigRaw: { compilerOptions: {} },
      write: false,
    })
    buildPromise.catch(() => {
      // Promise.race can return the timeout first. esbuild has no public abort
      // API for one-shot builds, so drain its eventual rejection instead of
      // letting Bun report it as an unhandled test/process error.
    })

    // Race esbuild against a timeout so a pathological build cannot stall the
    // request indefinitely. esbuild has no public abort API for one-shot
    // builds; if the timeout fires first the build promise still settles
    // later but we have already abandoned its result.
    let build: Awaited<typeof buildPromise>
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(
        () => reject(new Error(`runtime bundle timed out after ${bundleTimeoutMs}ms`)),
        bundleTimeoutMs,
      )
    })
    try {
      build = await Promise.race([buildPromise, timeoutPromise])
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle)
    }

    const files = build.outputFiles.map((file) => {
      const path = toPosixPath(relative(join(process.cwd(), outputRoot), file.path))
      return {
        path,
        publicPath: joinPublicPath(input.assetBasePath, path),
        content: file.text,
        bytes: file.contents,
        contentType: contentTypeForPath(path),
      }
    })
    const publicPathByOutput = new Map(files.map((file) => [`${outputRoot}/${file.path}`, file.publicPath]))
    const selectedByEntryPoint = selectedScriptByEntryPoint(moduleScripts)

    const moduleAssetScripts = Object.entries(build.metafile.outputs)
      .map(([
        outputPath,
        output,
      ]): PublishedRuntimeScriptAsset | null => {
        if (!output.entryPoint) return null
        const script = selectedByEntryPoint.get(output.entryPoint)
        const src = publicPathByOutput.get(outputPath)
        if (!script || !src) return null
        return {
          fileId: script.file.id,
          src,
          format: 'module' as const,
          placement: script.config.placement,
          timing: script.config.timing,
          priority: script.config.priority,
        }
      })
      .filter((script): script is PublishedRuntimeScriptAsset => script !== null)
    const scripts = [...moduleAssetScripts, ...classicBuild.assets]
      .sort((a, b) => a.priority - b.priority || a.src.localeCompare(b.src))

    return {
      files: [...files, ...classicBuild.files],
      runtimeAssets: { scripts },
      diagnostics: importAnalysis.diagnostics,
    }
  } catch (error) {
    return emptyRuntimeBuild([...importAnalysis.diagnostics, ...esbuildDiagnostics(error)])
  }
}
