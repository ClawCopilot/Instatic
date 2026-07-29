/**
 * Content-scope write tools — browser-bridged.
 *
 * These tools mutate the live Content workspace through the browser bridge.
 * The browser owns dirty Tiptap state and persists successful mutations, so
 * routing writes through it prevents a later autosave from overwriting a
 * server-direct database change.
 */

import { Type } from '@core/utils/typeboxHelpers'
import type { CoreCapability } from '@core/capabilities'
import type { AiTool } from '../types'

// `fields` is a free-form `Record<fieldId, value>`. Per-type validation
// happens on the browser bridge, which owns the collection's field schema.
const FieldsRecord = Type.Record(Type.String(), Type.Unknown())

const DocumentStatus = Type.Union([
  Type.Literal('draft'),
  Type.Literal('unpublished'),
  Type.Literal('published'),
  Type.Literal('scheduled'),
])

const DOCUMENT_EDIT_CAPS: readonly CoreCapability[] = [
  'content.edit.own',
  'content.edit.any',
  'content.manage',
]

const DOCUMENT_PUBLISH_CAPS: readonly CoreCapability[] = [
  'content.publish.own',
  'content.publish.any',
  'content.manage',
]

const DOCUMENT_REASSIGN_CAPS: readonly CoreCapability[] = [
  'content.edit.any',
  'content.manage',
]

const CreateDocumentInput = Type.Object({
  tableId: Type.String({ minLength: 1 }),
  fields: Type.Optional(FieldsRecord),
  status: Type.Optional(DocumentStatus),
})

const createDocumentTool: AiTool = {
  name: 'content_create_document',
  scope: 'content',
  execution: 'browser',
  requiredCapabilities: ['content.create'],
  description:
    "Create a new document in `tableId`. `fields` is a Record<fieldId, value> per the collection's schema; omit to create an empty draft. `status` defaults to 'draft'. Success data includes the new id as `documentId`; the bridge switches the editor to the new document.",
  inputSchema: CreateDocumentInput,
}

const DeleteDocumentInput = Type.Object({
  documentId: Type.String({ minLength: 1 }),
})

const deleteDocumentTool: AiTool = {
  name: 'content_delete_document',
  scope: 'content',
  execution: 'browser',
  requiredCapabilities: DOCUMENT_EDIT_CAPS,
  description: 'Soft-delete a document. The user can restore it via the Trash UI.',
  inputSchema: DeleteDocumentInput,
}

const SetDocumentStatusInput = Type.Object({
  documentId: Type.String({ minLength: 1 }),
  status: DocumentStatus,
  scheduledAt: Type.Optional(Type.String({ minLength: 1 })),
})

const setDocumentStatusTool: AiTool = {
  name: 'content_set_document_status',
  scope: 'content',
  execution: 'browser',
  requiredCapabilities: DOCUMENT_PUBLISH_CAPS,
  description:
    "Set the document's lifecycle status. `status='scheduled'` requires `scheduledAt` (ISO datetime). Publishing requires permission for this document or the global content.manage capability.",
  inputSchema: SetDocumentStatusInput,
}

const SetDocumentFieldInput = Type.Object({
  documentId: Type.String({ minLength: 1 }),
  fieldId: Type.String({ minLength: 1 }),
  value: Type.Unknown(),
})

const setDocumentFieldTool: AiTool = {
  name: 'content_set_document_field',
  scope: 'content',
  execution: 'browser',
  requiredCapabilities: DOCUMENT_EDIT_CAPS,
  description:
    "Write one field on a document. `value` depends on the field type; call content_get_collection_schema first when needed. The bridge converts markdown and Tiptap content automatically for body fields.",
  inputSchema: SetDocumentFieldInput,
}

const SetDocumentFieldsInput = Type.Object({
  documentId: Type.String({ minLength: 1 }),
  fields: FieldsRecord,
})

const setDocumentFieldsTool: AiTool = {
  name: 'content_set_document_fields',
  scope: 'content',
  execution: 'browser',
  requiredCapabilities: DOCUMENT_EDIT_CAPS,
  description:
    'Batch-write multiple fields on one document. Prefer this when generating or updating a complete document.',
  inputSchema: SetDocumentFieldsInput,
}

const SetDocumentAuthorInput = Type.Object({
  documentId: Type.String({ minLength: 1 }),
  userId: Type.String({ minLength: 1 }),
})

const setDocumentAuthorTool: AiTool = {
  name: 'content_set_document_author',
  scope: 'content',
  execution: 'browser',
  requiredCapabilities: DOCUMENT_REASSIGN_CAPS,
  description:
    'Reassign the document author to another user. Use content_list_users to find the user id.',
  inputSchema: SetDocumentAuthorInput,
}

const SetActiveDocumentInput = Type.Object({
  documentId: Type.String({ minLength: 1 }),
})

const setActiveDocumentTool: AiTool = {
  name: 'content_set_active_document',
  scope: 'content',
  execution: 'browser',
  description:
    "Switch the user's editor to this document so they can watch the work.",
  inputSchema: SetActiveDocumentInput,
}

const SetActiveCollectionInput = Type.Object({
  tableId: Type.String({ minLength: 1 }),
})

const setActiveCollectionTool: AiTool = {
  name: 'content_set_active_collection',
  scope: 'content',
  execution: 'browser',
  description: 'Switch the Content workspace sidebar to this collection.',
  inputSchema: SetActiveCollectionInput,
}

export const contentWriteTools: AiTool[] = [
  createDocumentTool,
  deleteDocumentTool,
  setDocumentStatusTool,
  setDocumentFieldTool,
  setDocumentFieldsTool,
  setDocumentAuthorTool,
  setActiveDocumentTool,
  setActiveCollectionTool,
]
