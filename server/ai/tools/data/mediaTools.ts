/**
 * Media-scope tools — server-resolved.
 *
 * Six tools for managing media assets and folders. These hit the media
 * repository directly through `ctx.db`. Upload is NOT exposed — AI cannot
 * receive binary files through tool calls; media must be uploaded via the
 * Media UI or the HTTP upload endpoint. The AI can list, inspect, tag, and
 * delete existing assets.
 */

import { Type, type Static } from '@core/utils/typeboxHelpers'
import type { CoreCapability } from '@core/capabilities'
import type { AiTool } from '../types'
import {
  listMediaAssets,
  getMediaAsset,
  softDeleteMediaAsset,
  updateMediaAssetMetadata,
} from '../../../repositories/media'
import {
  listMediaFolders,
  createMediaFolder,
} from '../../../repositories/mediaFolders'
import { nanoid } from 'nanoid'

// ---------------------------------------------------------------------------
// Capability requirements
// ---------------------------------------------------------------------------

// Media read — mirrors media-access HTTP guards.
const MEDIA_READ_CAPS: readonly CoreCapability[] = [
  'content.create',
  'content.edit.own',
  'content.edit.any',
  'content.manage',
]

// Media write — mirrors media-mutation HTTP guards.
const MEDIA_WRITE_CAPS: readonly CoreCapability[] = [
  'content.edit.own',
  'content.edit.any',
  'content.manage',
]

// ---------------------------------------------------------------------------
// Shared projections
// ---------------------------------------------------------------------------

function projectAsset(a: Awaited<ReturnType<typeof getMediaAsset>>) {
  if (!a) return null
  return {
    id: a.id,
    filename: a.filename,
    mimeType: a.mimeType,
    sizeBytes: a.sizeBytes,
    publicPath: a.publicPath,
    altText: a.altText,
    caption: a.caption,
    title: a.title,
    tags: a.tags,
    width: a.width,
    height: a.height,
    durationMs: a.durationMs,
    dominantColor: a.dominantColor,
    blurHash: a.blurHash,
    folderIds: a.folderIds,
    storageAdapterId: a.storageAdapterId,
    externallyHosted: a.externallyHosted,
    createdAt: a.createdAt,
    uploadedByUserId: a.uploadedByUserId,
    deletedAt: a.deletedAt,
  }
}

// ---------------------------------------------------------------------------
// media_list
// ---------------------------------------------------------------------------

const ListMediaInput = Type.Object({
  includeDeleted: Type.Optional(Type.Boolean()),
  search: Type.Optional(Type.String()),
  mimePrefix: Type.Optional(Type.String()),
  folderId: Type.Optional(Type.String()),
})

const listMediaTool: AiTool = {
  name: 'media_list',
  scope: 'data',
  execution: 'server',
  requiredCapabilities: MEDIA_READ_CAPS,
  description:
    'List every non-deleted media asset in the project. Returns id, filename, mimeType, sizeBytes, publicPath (URL for use in <img src>), altText, caption, title, tags, dimensions, blurHash, and folderIds. Optionally filter by `folderId`, `search` (substring match against filename), or `mimePrefix` (e.g. "image/", "video/"). Set `includeDeleted: true` to list trashed assets.',
  inputSchema: ListMediaInput,
  handler: async (input, ctx) => {
    const args = input as Static<typeof ListMediaInput>
    const assets = await listMediaAssets(ctx.db, {
      includeDeleted: args.includeDeleted ?? false,
    })

    let filtered = assets
    if (args.folderId) {
      filtered = filtered.filter((a) => a.folderIds.includes(args.folderId))
    }
    if (args.search) {
      const q = args.search.toLowerCase()
      filtered = filtered.filter((a) =>
        a.filename.toLowerCase().includes(q) ||
        a.altText.toLowerCase().includes(q) ||
        a.tags.some((t) => t.includes(q)),
      )
    }
    if (args.mimePrefix) {
      filtered = filtered.filter((a) => a.mimeType.startsWith(args.mimePrefix))
    }

    return {
      total: filtered.length,
      assets: filtered.map((a) => projectAsset(a)),
    }
  },
}

// ---------------------------------------------------------------------------
// media_get
// ---------------------------------------------------------------------------

const GetMediaInput = Type.Object({
  assetId: Type.String({ minLength: 1 }),
})

const getMediaTool: AiTool = {
  name: 'media_get',
  scope: 'data',
  execution: 'server',
  requiredCapabilities: MEDIA_READ_CAPS,
  description:
    "Return one media asset's full metadata: filename, mimeType, dimensions, altText/caption/title, tags, folder memberships, public URL, and timestamps. Use `publicPath` as the img/src URL.",
  inputSchema: GetMediaInput,
  handler: async (input, ctx) => {
    const { assetId } = input as Static<typeof GetMediaInput>
    const asset = await getMediaAsset(ctx.db, assetId)
    if (!asset) {
      return { ok: false, error: `Media asset ${assetId} not found.` }
    }
    return { asset: projectAsset(asset) }
  },
}

// ---------------------------------------------------------------------------
// media_delete
// ---------------------------------------------------------------------------

const DeleteMediaInput = Type.Object({
  assetId: Type.String({ minLength: 1 }),
})

const deleteMediaTool: AiTool = {
  name: 'media_delete',
  scope: 'data',
  execution: 'server',
  requiredCapabilities: MEDIA_WRITE_CAPS,
  description:
    'Soft-delete a media asset (moves to Trash). The user can restore it from the Media UI. Hard-delete requires removing the on-disk file and is not available to AI.',
  inputSchema: DeleteMediaInput,
  handler: async (input, ctx) => {
    const { assetId } = input as Static<typeof DeleteMediaInput>
    const deleted = await softDeleteMediaAsset(ctx.db, assetId)
    if (!deleted) {
      return { ok: false, error: `Media asset ${assetId} not found or already deleted.` }
    }
    return { ok: true, deleted: { id: deleted.id, filename: deleted.filename, deletedAt: deleted.deletedAt } }
  },
}

// ---------------------------------------------------------------------------
// media_update_metadata
// ---------------------------------------------------------------------------

const UpdateMediaMetadataInput = Type.Object({
  assetId: Type.String({ minLength: 1 }),
  filename: Type.Optional(Type.String()),
  altText: Type.Optional(Type.String()),
  caption: Type.Optional(Type.String()),
  title: Type.Optional(Type.String()),
  tags: Type.Optional(Type.Array(Type.String())),
})

const updateMediaMetadataTool: AiTool = {
  name: 'media_update_metadata',
  scope: 'data',
  execution: 'server',
  requiredCapabilities: MEDIA_WRITE_CAPS,
  description:
    "Update a media asset's user-editable metadata: filename (display name), altText (accessibility), caption, title, and tags (string array, auto-lowercased + deduped). Omit a field to leave it unchanged. Returns the updated asset.",
  inputSchema: UpdateMediaMetadataInput,
  handler: async (input, ctx) => {
    const args = input as Static<typeof UpdateMediaMetadataInput>
    const updated = await updateMediaAssetMetadata(ctx.db, args.assetId, {
      filename: args.filename,
      altText: args.altText,
      caption: args.caption,
      title: args.title,
      tags: args.tags,
    })
    if (!updated) {
      return { ok: false, error: `Media asset ${args.assetId} not found.` }
    }
    return { ok: true, asset: projectAsset(updated) }
  },
}

// ---------------------------------------------------------------------------
// media_list_folders
// ---------------------------------------------------------------------------

const listFoldersTool: AiTool = {
  name: 'media_list_folders',
  scope: 'data',
  execution: 'server',
  requiredCapabilities: MEDIA_READ_CAPS,
  description:
    'List every media folder in the project (tree structure via `parentId`). Returns id, parentId, name, slug, sortOrder.',
  inputSchema: Type.Object({}),
  handler: async (_input, ctx) => {
    const folders = await listMediaFolders(ctx.db)
    return {
      total: folders.length,
      folders: folders.map((f) => ({
        id: f.id,
        parentId: f.parentId,
        name: f.name,
        slug: f.slug,
        sortOrder: f.sortOrder,
        createdAt: f.createdAt,
      })),
    }
  },
}

// ---------------------------------------------------------------------------
// media_create_folder
// ---------------------------------------------------------------------------

const CreateFolderInput = Type.Object({
  name: Type.String({ minLength: 1 }),
  slug: Type.Optional(Type.String({ minLength: 1 })),
  parentId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
})

const createFolderTool: AiTool = {
  name: 'media_create_folder',
  scope: 'data',
  execution: 'server',
  requiredCapabilities: MEDIA_WRITE_CAPS,
  description:
    "Create a media folder. `name` is the human-readable label. `slug` is auto-derived from name if omitted. `parentId` is null for root or the id of a parent folder. Returns the created folder.",
  inputSchema: CreateFolderInput,
  handler: async (input, ctx) => {
    const args = input as Static<typeof CreateFolderInput>
    const slug = args.slug ?? args.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    const folder = await createMediaFolder(ctx.db, {
      id: nanoid(),
      parentId: args.parentId ?? null,
      name: args.name.trim(),
      slug,
      createdByUserId: ctx.userId,
    })
    return {
      ok: true,
      folder: {
        id: folder.id,
        parentId: folder.parentId,
        name: folder.name,
        slug: folder.slug,
        sortOrder: folder.sortOrder,
        createdAt: folder.createdAt,
      },
    }
  },
}

// ---------------------------------------------------------------------------
// Barrel
// ---------------------------------------------------------------------------

export const mediaTools: AiTool[] = [
  listMediaTool,
  getMediaTool,
  deleteMediaTool,
  updateMediaMetadataTool,
  listFoldersTool,
  createFolderTool,
]
