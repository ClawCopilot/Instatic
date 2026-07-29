let cachedSettingsByPluginId = new Map<string, Record<string, unknown>>()

export function replacePluginSettingsCache(
  next: Map<string, Record<string, unknown>>,
): void {
  cachedSettingsByPluginId = next
}

export function getPluginSettings(pluginId: string): Record<string, unknown> {
  return cachedSettingsByPluginId.get(pluginId) ?? {}
}
