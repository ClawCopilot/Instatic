import { Button } from '@ui/components/Button'
import { AdminPageLayout } from '@admin/layouts/AdminPageLayout'
import { PluginCard } from './components/PluginCard/PluginCard'
import { PluginRemoveDialog } from './components/PluginRemoveDialog/PluginRemoveDialog'
import { PermissionReviewSection } from './components/PermissionReviewSection'
import { PluginSettingsDialog } from './components/PluginSettingsDialog/PluginSettingsDialog'
import { PluginSchedulesDialog } from './components/PluginSchedulesDialog/PluginSchedulesDialog'
import { isSandboxRelatedError, usePluginsWorkspace } from './hooks/usePluginsWorkspace'
import { notifyCmsPluginsChanged } from './utils/pluginEvents'
import { useAuthenticatedAdminUser } from '@admin/sessionContext'
import {
  canConfigurePlugins,
  canInstallPlugins,
  canManagePluginLifecycle,
} from '@admin/access'
import styles from './PluginsPage.module.css'

// Number of skeleton plugin cards rendered while the installed-plugin
// list is loading.
const SKELETON_CARD_COUNT = 3

export function SkillsPage() {
  const currentUser = useAuthenticatedAdminUser()
  const canConfigure = canConfigurePlugins(currentUser)
  const canInstall = canInstallPlugins(currentUser)
  const canManageLifecycle = canManagePluginLifecycle(currentUser)
  const vm = usePluginsWorkspace()
  const {
    fileInputRef,
    payload,
    loading,
    uploading,
    busyPluginId,
    error,
    editorActivationErrors,
    pendingInstall,
    settingsPluginId,
    schedulesPluginId,
    pendingRemove,
    removeFailure,
  } = vm

  // Filter to only show skills
  const skills = loading
    ? []
    : payload.plugins.filter((p) => (p.manifest.kind ?? 'plugin') === 'skill')

  return (
    <AdminPageLayout
      workspace="skills"
      title="Skills"
      titleId="skills-title"
      description="Manage AI-powered skills that extend your CMS with intelligent capabilities."
    >
      <div className={styles.pluginsBody} data-testid="skills-admin-canvas">
        {error && (
          <div role="alert">
            <p className={styles.error}>{error}</p>
            {isSandboxRelatedError(error) && (
              <p className={styles.errorHint}>
                This looks like a plugin sandbox issue. See the{' '}
                <a
                  href="https://github.com/clawcopilot/instatic/blob/main/docs/features/plugin-system.md"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  sandbox documentation
                </a>
                {' '}for what's allowed inside skill code.
              </p>
            )}
          </div>
        )}

        {removeFailure && (
          <div role="alert" className={styles.removeFailure}>
            <p className={styles.error}>{removeFailure.message}</p>
            <p className={styles.errorHint}>
              Removing anyway skips the skill&rsquo;s cleanup code — external
              resources it created (webhooks, third-party registrations) may
              remain.
            </p>
            <div className={styles.removeFailureActions}>
              <Button
                variant="destructive"
                size="sm"
                disabled={busyPluginId === removeFailure.plugin.id}
                onClick={() =>
                  vm.setPendingRemove({ plugin: removeFailure.plugin, force: true })
                }
              >
                Remove anyway
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => vm.setRemoveFailure(null)}
              >
                Dismiss
              </Button>
            </div>
          </div>
        )}

        {pendingInstall && canInstall && (
          <PermissionReviewSection
            pending={pendingInstall}
            uploading={uploading}
            onCancel={() => vm.setPendingInstall(null)}
            onConfirm={() => void vm.installPendingPlugin(pendingInstall)}
          />
        )}

        <div
          className={styles.pluginsList}
          aria-label="Installed skills"
          aria-busy={loading || undefined}
        >
          {loading ? (
            Array.from({ length: SKELETON_CARD_COUNT }, (_, i) => (
              <PluginCard key={i} loading />
            ))
          ) : skills.length === 0 ? (
            <p className={styles.emptyState}>
              No skills installed yet. Install skills from the{' '}
              <a
                href="https://clawhub.ai"
                target="_blank"
                rel="noopener noreferrer"
              >
                ClawHub marketplace
              </a>{' '}
              or add them via the Plugins page.
            </p>
          ) : (
            skills.map((plugin) => (
              <PluginCard
                key={plugin.id}
                plugin={plugin}
                busy={busyPluginId === plugin.id}
                editorActivationError={editorActivationErrors[plugin.id]}
                canConfigure={canConfigure}
                canInstall={canInstall}
                canManageLifecycle={canManageLifecycle}
                onOpenSettings={(p) => vm.setSettingsPluginId(p.id)}
                onOpenSchedules={(p) => vm.setSchedulesPluginId(p.id)}
                onInstallPack={(p) => void vm.installPluginPack(p)}
                onRestart={(p) => void vm.restartPlugin(p)}
                onReinstall={() => fileInputRef.current?.click()}
                onToggle={(p) => void vm.togglePlugin(p)}
                onRemove={(p) => vm.setPendingRemove({ plugin: p, force: false })}
              />
            ))
          )}
        </div>

        {settingsPluginId && (
          <PluginSettingsDialog
            pluginId={settingsPluginId}
            pluginName={
              payload.plugins.find((p) => p.id === settingsPluginId)?.name ??
              settingsPluginId
            }
            onClose={() => vm.setSettingsPluginId(null)}
            onSaved={() => {
              notifyCmsPluginsChanged()
              void vm.loadPlugins()
            }}
          />
        )}

        {schedulesPluginId && (
          <PluginSchedulesDialog
            pluginId={schedulesPluginId}
            pluginName={
              payload.plugins.find((p) => p.id === schedulesPluginId)?.name ??
              schedulesPluginId
            }
            canManageLifecycle={canManageLifecycle}
            onClose={() => vm.setSchedulesPluginId(null)}
          />
        )}

        {pendingRemove && (
          <PluginRemoveDialog
            plugin={pendingRemove.plugin}
            force={pendingRemove.force}
            busy={busyPluginId === pendingRemove.plugin.id}
            onClose={() => vm.setPendingRemove(null)}
            onConfirm={async () => {
              const target = pendingRemove
              vm.setPendingRemove(null)
              await vm.executeRemovePlugin(target.plugin, target.force)
            }}
          />
        )}
      </div>
    </AdminPageLayout>
  )
}