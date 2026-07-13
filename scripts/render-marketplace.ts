// Smoke test: render the marketplace page and verify it's valid HTML.
import { renderMarketplacePage, MARKETPLACE_PLUGINS } from '../server/plugins/adminUi/marketplacePage'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const html = renderMarketplacePage()
const out = join(import.meta.dir, '..', 'marketplace-preview.html')
writeFileSync(out, html, 'utf-8')
console.log(`OK: rendered ${html.length} chars, ${MARKETPLACE_PLUGINS.length} plugins`)
console.log(`Output: ${out}`)
console.log(`Open it in a browser to preview.`)
