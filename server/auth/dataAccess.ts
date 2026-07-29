import type { CoreCapability } from '@core/capabilities'
import type { DataRow, DataTable } from '@core/data/schemas'
import { roleHasCapability } from './capabilities'

export interface DataAccessPrincipal {
  id: string
  capabilities: readonly CoreCapability[]
}

type OwnedDataRow = Pick<DataRow, 'authorUserId' | 'createdByUserId'>
type VisibleDataTable = Pick<DataTable, 'system'>

function hasAnyCapability(
  principal: Pick<DataAccessPrincipal, 'capabilities'>,
  capabilities: readonly CoreCapability[],
): boolean {
  return capabilities.some((capability) => (
    roleHasCapability(principal.capabilities, capability)
  ))
}

export function canReadDataTable(
  principal: DataAccessPrincipal,
  table: VisibleDataTable,
): boolean {
  return hasAnyCapability(
    principal,
    table.system
      ? ['data.system.tables.read', 'data.system.tables.manage']
      : ['data.custom.tables.read', 'data.custom.tables.manage'],
  )
}

export function canManageDataTable(
  principal: DataAccessPrincipal,
  table: VisibleDataTable,
): boolean {
  return roleHasCapability(
    principal.capabilities,
    table.system ? 'data.system.tables.manage' : 'data.custom.tables.manage',
  )
}

export function ownsDataRow(
  principal: Pick<DataAccessPrincipal, 'id'>,
  row: OwnedDataRow,
): boolean {
  return row.authorUserId === principal.id
    || (row.authorUserId === null && row.createdByUserId === principal.id)
}

export function canSeeAllDataRows(
  principal: DataAccessPrincipal,
): boolean {
  return hasAnyCapability(principal, [
    'content.edit.any',
    'content.publish.any',
    'content.manage',
  ])
}

export function canReadDataRow(
  principal: DataAccessPrincipal,
  row: OwnedDataRow,
): boolean {
  if (canSeeAllDataRows(principal)) return true
  if (!ownsDataRow(principal, row)) return false
  return hasAnyCapability(principal, [
    'content.create',
    'content.edit.own',
    'content.publish.own',
  ])
}

export function canEditDataRow(
  principal: DataAccessPrincipal,
  row: OwnedDataRow,
): boolean {
  return hasAnyCapability(principal, ['content.edit.any', 'content.manage'])
    || (
      ownsDataRow(principal, row)
      && roleHasCapability(principal.capabilities, 'content.edit.own')
    )
}

export function canPublishDataRow(
  principal: DataAccessPrincipal,
  row: OwnedDataRow,
): boolean {
  return hasAnyCapability(principal, ['content.publish.any', 'content.manage'])
    || (
      ownsDataRow(principal, row)
      && roleHasCapability(principal.capabilities, 'content.publish.own')
    )
}

export function dataRowVisibility(
  principal: DataAccessPrincipal,
): { ownerUserId?: string } {
  return canSeeAllDataRows(principal) ? {} : { ownerUserId: principal.id }
}
