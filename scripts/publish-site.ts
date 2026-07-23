import { createDbClient } from '../server/db'
import { publishDraftSite } from '../server/publish/publishSite'
import { resolve } from 'node:path'

const { db } = createDbClient('file:.tmp/dev.db')

async function main() {
  try {
    const uploadsDir = resolve('.local')
    await publishDraftSite(db, 'bWycrdluYJAl0WZCFtI9I', uploadsDir)
    console.log('Site published successfully!')
  } catch (err) {
    console.error('Publish failed:', err)
  } finally {
    await db.destroy?.()
  }
}

main()
