type AssertTargetPermission = (target: string) => void
type HostCall = (target: string, args: unknown[]) => Promise<unknown>
type NextId = (prefix: string) => string

/**
 * Build the top-level render-extension and secret-store APIs.
 *
 * Their callbacks stay inside the QuickJS handler registry. The host receives
 * only validated metadata and calls the registered VM callback when needed.
 */
export function buildExtensionApis(
  assertTargetPermission: AssertTargetPermission,
  call: HostCall,
  nextId: NextId,
) {
  function registerViewerContext(provider: unknown) {
    assertTargetPermission('cms.viewerContext.register')
    if (typeof provider !== 'function') {
      throw new TypeError('viewerContext.register: provider must be a function')
    }
    const providerId = nextId('vcProvider')
    globalThis.__plugin_handlers.viewContextProviders ??= {}
    globalThis.__plugin_handlers.viewContextProviders[providerId] = provider as BootstrapFn
    return call('cms.viewerContext.register', [{}])
  }

  function registerContentGate(gate: unknown, priority?: unknown) {
    assertTargetPermission('cms.contentGate.register')
    if (typeof gate !== 'function') {
      throw new TypeError('contentGate.register: gate must be a function')
    }
    const gateId = nextId('contentGate')
    globalThis.__plugin_handlers.contentGates ??= {}
    globalThis.__plugin_handlers.contentGates[gateId] = gate as BootstrapFn
    const normalizedPriority = typeof priority === 'number' ? Math.floor(priority) : 100
    return call('cms.contentGate.register', [{ priority: normalizedPriority }])
  }

  function getSecret(key: unknown) {
    assertTargetPermission('cms.secrets.get')
    return call('cms.secrets.get', [{ key: String(key) }])
  }

  function setSecret(key: unknown, value: unknown) {
    assertTargetPermission('cms.secrets.set')
    return call('cms.secrets.set', [{ key: String(key), value: String(value) }])
  }

  return {
    viewerContext: { register: registerViewerContext },
    contentGate: { register: registerContentGate },
    secrets: { get: getSecret, set: setSecret },
  }
}
