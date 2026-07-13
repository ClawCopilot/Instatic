/**
 * Product variants — a single product can have N variants
 * (size, color, material, etc.). Each variant has its own SKU, price,
 * and inventory tracking.
 *
 * Source of truth for the variant SET is the product's `cells_json.variants[]`
 * (managed via the standard CMS data row editor). The product_variants
 * table holds the per-variant inventory ledger.
 *
 * Cart integration:
 *   - line items carry { productId, variantId, quantity, ... }
 *   - variantId is required when the product has variants
 *   - variant lookup validates enabled + inventory
 *
 * Inventory tracking:
 *   - On order placement: adjustInventory(productId, -qty, 'order_placed', orderId, notes=variantId)
 *   - On cancel: +qty with 'order_canceled'
 *   - On restock: +qty with 'restock'
 *   - The notes field carries the variant id; per-variant stock is
 *     `SUM(delta) WHERE product_id = ? AND notes = ?`
 */

import { randomBytes } from 'node:crypto'
import type { DbClient } from '@instatic/plugin-sdk/host'

export interface ProductVariant {
  id: string
  productId: string
  variantKey: string  // human-readable key, e.g. "red-medium"
  sku: string
  label: string
  priceCents: number
  currency: string
  enabled: boolean
  sortOrder: number
  attributes: Record<string, string>  // e.g. { color: 'red', size: 'M' }
  createdAt: string
  updatedAt: string
}

export interface VariantInventory {
  variantId: string
  available: number  // sum of all deltas
}

interface VariantRow {
  id: string
  product_id: string
  variant_key: string
  sku: string
  label: string
  price_cents: number
  currency: string
  enabled: boolean | number
  sort_order: number
  attributes_json: string | Record<string, string>
  created_at: string
  updated_at: string
}

function parseJson<T>(value: string | T): T {
  return typeof value === 'string' ? JSON.parse(value) as T : value
}

function rowToVariant(row: VariantRow): ProductVariant {
  return {
    id: row.id,
    productId: row.product_id,
    variantKey: row.variant_key,
    sku: row.sku,
    label: row.label,
    priceCents: row.price_cents,
    currency: row.currency,
    enabled: !!row.enabled,
    sortOrder: row.sort_order,
    attributes: parseJson<Record<string, string>>(row.attributes_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

// ─── Variant CRUD ───────────────────────────────────────────────────────

export async function listVariantsForProduct(
  db: DbClient,
  productId: string,
): Promise<ProductVariant[]> {
  const { rows } = await db<VariantRow>`
    select * from product_variants
    where product_id = ${productId} and enabled = true
    order by sort_order, variant_key
  `
  return rows.map(rowToVariant)
}

export async function findVariant(
  db: DbClient,
  productId: string,
  variantId: string,
): Promise<ProductVariant | null> {
  const { rows } = await db<VariantRow>`
    select * from product_variants
    where id = ${variantId} and product_id = ${productId}
    limit 1
  `
  return rows[0] ? rowToVariant(rows[0]) : null
}

export async function upsertVariant(
  db: DbClient,
  args: Omit<ProductVariant, 'createdAt' | 'updatedAt'>,
): Promise<ProductVariant> {
  const { rows } = await db<VariantRow>`
    insert into product_variants (
      id, product_id, variant_key, sku, label, price_cents, currency,
      enabled, sort_order, attributes_json
    ) values (
      ${args.id}, ${args.productId}, ${args.variantKey}, ${args.sku},
      ${args.label}, ${args.priceCents}, ${args.currency},
      ${args.enabled}, ${args.sortOrder},
      ${JSON.stringify(args.attributes)}::jsonb
    )
    on conflict (product_id, variant_key) do update
    set sku = excluded.sku,
        label = excluded.label,
        price_cents = excluded.price_cents,
        enabled = excluded.enabled,
        sort_order = excluded.sort_order,
        attributes_json = excluded.attributes_json,
        updated_at = now()
    returning *
  `
  return rowToVariant(rows[0])
}

export async function deleteVariant(db: DbClient, id: string): Promise<void> {
  await db`update product_variants set enabled = false where id = ${id}`
}

// ─── Per-variant inventory ──────────────────────────────────────────────

/**
 * Get the current available stock for a variant by summing the
 * inventory_ledger rows tagged with the variant id (in the notes column).
 */
export async function getVariantInventory(
  db: DbClient,
  variantId: string,
): Promise<number> {
  const { rows } = await db<{ sum: number | null }>`
    select coalesce(sum(delta), 0)::int as sum
    from inventory_ledger
    where notes = ${variantId}
  `
  return rows[0]?.sum ?? 0
}

export async function getVariantInventories(
  db: DbClient,
  productId: string,
): Promise<Map<string, number>> {
  const variants = await listVariantsForProduct(db, productId)
  const map = new Map<string, number>()
  for (const v of variants) {
    map.set(v.id, await getVariantInventory(db, v.id))
  }
  return map
}

/**
 * Adjust a variant's inventory. Wraps the standard adjustInventory with
 * the variant id stored in the notes column.
 */
export async function adjustVariantInventory(
  db: DbClient,
  productId: string,
  variantId: string,
  delta: number,
  reason: 'order_placed' | 'order_canceled' | 'restock' | 'manual_adjustment' | 'return',
  referenceId: string | null,
): Promise<void> {
  await db`
    insert into inventory_ledger (id, product_id, delta, reason, reference_id, notes)
    values (
      ${`inv_${randomBytes(8).toString('hex')}`},
      ${productId}, ${delta}, ${reason}, ${referenceId}, ${variantId}
    )
  `
}

/**
 * Build a variant id from product cells.variants[] entry.
 * The product's variants[] array is the SOURCE OF TRUTH for the SET;
 * this function ensures the DB row exists for inventory tracking.
 */
export async function syncVariantsForProduct(
  db: DbClient,
  productId: string,
  declaredVariants: Array<{ variantKey: string; sku: string; label: string; priceCents: number; attributes?: Record<string, string> }>,
): Promise<ProductVariant[]> {
  const result: ProductVariant[] = []
  for (let i = 0; i < declaredVariants.length; i++) {
    const v = declaredVariants[i]
    const id = `var_${productId.slice(0, 12)}_${v.variantKey.replace(/[^a-z0-9]/gi, '_')}`
    const upserted = await upsertVariant(db, {
      id,
      productId,
      variantKey: v.variantKey,
      sku: v.sku,
      label: v.label,
      priceCents: v.priceCents,
      currency: 'USD',
      enabled: true,
      sortOrder: i,
      attributes: v.attributes ?? {},
    })
    result.push(upserted)
  }
  return result
}