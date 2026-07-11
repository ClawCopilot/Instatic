/**
 * Webhook subsystem barrel.
 *
 * `startWebhookDispatcher(db)` registers listeners on the shared hook bus
 * so that every core content + publish event fires matching webhooks.
 * Call once at server boot after the hook bus is initialised.
 */

export { startWebhookDispatcher } from './dispatcher'
