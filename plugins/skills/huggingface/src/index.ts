/**
 * HuggingFace Skill
 *
 * Seamless integration with the HuggingFace Hub: search models, datasets,
 * Spaces, get model details, and run inference on 800K+ ML models.
 *
 * Tool handlers are implemented centrally in
 * `server/ai/tools/plugin/toolHandlers.ts` (local handler pattern).
 */

export default {
  async install() {},
  async activate() {
    console.log('[huggingface] Activated')
  },
  async deactivate() {},
  async uninstall() {},
}
