/**
 * Media upload tools — server-resolved.
 *
 * One tool: `media_upload_from_url`. Downloads a file from a public URL,
 * detects its MIME type from magic bytes, writes it to the uploads
 * directory, and creates a media_asset record. Requires uploadsDir to be
 * configured on the server (the tool gates on `ctx.uploadsDir`).
 */

import { writeFile, mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { Type, type Static } from '@core/utils/typeboxHelpers'
import type { CoreCapability } from '@core/capabilities'
import type { AiTool } from '../types'
import { createMediaAsset } from '../../../repositories/media'
import { nanoid } from 'nanoid'

// ---------------------------------------------------------------------------
// Capability requirements
// ---------------------------------------------------------------------------

const UPLOAD_CAPS: readonly CoreCapability[] = [
  'content.create',
  'content.edit.own',
  'content.edit.any',
  'content.manage',
]

// ---------------------------------------------------------------------------
// MIME detection helpers (minimal subset — mirrors mediaUpload.ts)
// ---------------------------------------------------------------------------

const MAGIC_SIGNATURES: { mime: string; bytes: [number, number][] }[] = [
  { mime: 'image/png',       bytes: [[0, 0x89], [1, 0x50], [2, 0x4E], [3, 0x47]] },
  { mime: 'image/jpeg',      bytes: [[0, 0xFF], [1, 0xD8], [2, 0xFF]] },
  { mime: 'image/webp',      bytes: [[0, 0x52], [1, 0x49], [2, 0x46], [3, 0x46], [8, 0x57], [9, 0x45], [10, 0x42], [11, 0x50]] },
  { mime: 'image/gif',       bytes: [[0, 0x47], [1, 0x49], [2, 0x46]] },
  { mime: 'image/avif',      bytes: [[4, 0x66], [5, 0x74], [6, 0x79], [7, 0x70], [8, 0x61], [9, 0x76], [10, 0x69], [11, 0x66]] },
  { mime: 'video/mp4',       bytes: [[4, 0x66], [5, 0x74], [6, 0x79], [7, 0x70]] }, // ftyp box
  { mime: 'video/webm',      bytes: [[0, 0x1A], [1, 0x45], [2, 0xDF], [3, 0xA3]] },
  { mime: 'application/pdf', bytes: [[0, 0x25], [1, 0x50], [2, 0x44], [3, 0x46]] },
]

const MIME_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/avif': '.avif',
  'image/svg+xml': '.svg',
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'application/pdf': '.pdf',
}

function detectMime(bytes: Uint8Array): string | null {
  for (const sig of MAGIC_SIGNATURES) {
    if (sig.bytes.every(([offset, expected]) => offset < bytes.length && bytes[offset] === expected)) {
      return sig.mime
    }
  }
  // SVG fallback
  const head = new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, 512)).trimStart()
  if (head.startsWith('<?xml') || head.startsWith('<svg')) return 'image/svg+xml'
  return null
}

function safeStorageStem(str: string): string {
  const normalized = str.replace(/\\/g, '/').split('/').pop() ?? 'upload'
  const stem = normalized.replace(/\.[^.]*$/, '').replace(/[^a-zA-Z0-9_-]/g, '_').replace(/^_+/, '')
  return stem || 'upload'
}

// ---------------------------------------------------------------------------
// media_upload_from_url
// ---------------------------------------------------------------------------

const UploadFromUrlInput = Type.Object({
  url: Type.String({ minLength: 1 }),
  filename: Type.Optional(Type.String()),
  folderId: Type.Optional(Type.String()),
})

const uploadFromUrlTool: AiTool = {
  name: 'media_upload_from_url',
  scope: 'data',
  execution: 'server',
  requiredCapabilities: UPLOAD_CAPS,
  description:
    'Download a file from a public URL and add it to the media library. `url` is the source (must be a valid HTTP/HTTPS URL). `filename` is optional — derived from the URL path if omitted. `folderId` optionally places the asset in a media folder. Returns the created media asset with its `publicPath` (use as img src / video src in content). The server must have an uploads directory configured. Supports images (png, jpeg, webp, gif, avif, svg), videos (mp4, webm), and PDFs.',
  inputSchema: UploadFromUrlInput,
  handler: async (input, ctx) => {
    const args = input as Static<typeof UploadFromUrlInput>

    const uploadsDir = ctx.uploadsDir
    if (!uploadsDir) {
      return { ok: false, error: 'Server has no uploads directory configured — media_upload_from_url requires disk storage.' }
    }

    let url: URL
    try {
      url = new URL(args.url)
    } catch {
      return { ok: false, error: `Invalid URL: ${args.url}. Must be a valid HTTP/HTTPS URL.` }
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return { ok: false, error: `Unsupported protocol: ${url.protocol}. Only http: and https: are allowed.` }
    }

    // 1. Download
    let bytes: ArrayBuffer
    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 30_000)
      const res = await fetch(url.toString(), {
        signal: controller.signal,
        headers: { 'User-Agent': 'Instatic/1.0 (media-upload)' },
      })
      clearTimeout(timeout)
      if (!res.ok) {
        return { ok: false, error: `Download failed: HTTP ${res.status} ${res.statusText} from ${url.hostname}` }
      }
      const contentLength = res.headers.get('content-length')
      const maxBytes = 100 * 1024 * 1024 // 100 MB
      if (contentLength && Number(contentLength) > maxBytes) {
        return { ok: false, error: `File too large: ${contentLength} bytes (max ${maxBytes} bytes).` }
      }
      bytes = await res.arrayBuffer()
      if (bytes.byteLength > maxBytes) {
        return { ok: false, error: `File too large: ${bytes.byteLength} bytes (max ${maxBytes} bytes).` }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { ok: false, error: `Failed to fetch URL: ${message}` }
    }

    // 2. Detect MIME
    const mimeType = detectMime(new Uint8Array(bytes))
    if (!mimeType) {
      return { ok: false, error: 'Unrecognised file format. Supported: png, jpeg, webp, gif, avif, svg, mp4, webm, pdf.' }
    }

    // 3. Generate storage path: media/<yyyymm>/<stem><ext>
    const now = new Date()
    const month = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`
    const stem = safeStorageStem(args.filename ?? url.pathname.split('/').pop() ?? 'upload')
    const ext = MIME_EXT[mimeType] ?? '.bin'
    const storagePath = `media/${month}/${stem}-${nanoid(8)}${ext}`

    // 4. Write to disk
    const targetPath = join(uploadsDir, storagePath)
    try {
      await mkdir(dirname(targetPath), { recursive: true })
      await writeFile(targetPath, new Uint8Array(bytes))
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { ok: false, error: `Failed to write file to disk: ${message}` }
    }

    // 5. Create media asset record
    const assetId = nanoid()
    const publicPath = `/uploads/${storagePath}`
    try {
      const asset = await createMediaAsset(ctx.db, {
        id: assetId,
        filename: args.filename ?? stem + ext,
        mimeType,
        sizeBytes: bytes.byteLength,
        storagePath,
        publicPath,
        uploadedByUserId: ctx.userId,
        storageAdapterId: '',
        externallyHosted: false,
      })

      return {
        ok: true,
        asset: {
          id: asset.id,
          filename: asset.filename,
          mimeType: asset.mimeType,
          sizeBytes: asset.sizeBytes,
          publicPath: asset.publicPath,
          width: asset.width,
          height: asset.height,
          storagePath,
        },
        message: `Uploaded "${asset.filename}" (${asset.mimeType}, ${asset.sizeBytes} bytes). Use publicPath "${asset.publicPath}" as the img/video src.`,
      }
    } catch (err) {
      // Clean up the file we just wrote
      const { unlink } = await import('node:fs/promises')
      await unlink(targetPath).catch(() => {})
      const message = err instanceof Error ? err.message : String(err)
      return { ok: false, error: `Failed to create media asset record: ${message}` }
    }
  },
}

// ---------------------------------------------------------------------------
// Barrel
// ---------------------------------------------------------------------------

export const uploadTools: AiTool[] = [uploadFromUrlTool]
