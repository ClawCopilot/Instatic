/**
 * Render-time data context shared by structured dynamic bindings and inline
 * token interpolation.
 */

import type { LoopItem } from '@core/loops/types'
import type {
  PageFrame,
  RouteFrame,
  SiteFrame,
} from './contextFrames'

/**
 * Render-time context handed to the publisher.
 *
 * `entryStack` is an immutable snapshot for the current frame. Stack-top
 * resolves `currentEntry`; one below resolves `parentEntry`. The named frames
 * are built by the publisher and referenced by their matching binding sources.
 */
/**
 * Per-request viewer state — populated by plugins via the `viewerContext`
 * extension point (server/plugins/extensions/viewerContext.ts).
 *
 * Membership plugins put `{ tier, expiresAt, ... }` here; commerce plugins
 * put `{ cartCount, ... }`. Templates read these via `{viewer.tier}` token
 * syntax or via the `viewer` dynamic binding source.
 */
export interface ViewerFrame {
  readonly [key: string]: unknown
}

export interface TemplateRenderDataContext {
  readonly entryStack: readonly LoopItem[]
  readonly page?: PageFrame
  readonly site?: SiteFrame
  readonly route?: RouteFrame
  /**
   * Per-request viewer state, resolved by plugin viewer-context providers.
   * Optional — absent when no plugin has registered a provider.
   */
  readonly viewer?: ViewerFrame
}
