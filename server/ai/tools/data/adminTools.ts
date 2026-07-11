/**
 * Admin-scope tools — server-resolved.
 *
 * Five tools for user and role management. These mirror the admin HTTP
 * endpoints and require admin-level capabilities. The AI uses these to
 * manage team members, assign roles, and configure permissions.
 *
 * Password management is deliberately excluded — the AI cannot set or
 * reset passwords. Use the admin UI or invite flow for that.
 */

import { Type, type Static } from '@core/utils/typeboxHelpers'
import type { CoreCapability } from '@core/capabilities'
import type { AiTool } from '../types'
import {
  listUsers,
  findUserById,
  updateUser,
} from '../../../repositories/users'
import {
  listRoles,
  createCustomRole,
} from '../../../repositories/roles'

// ---------------------------------------------------------------------------
// Capability requirements
// ---------------------------------------------------------------------------

// Admin read — users list/read.
const ADMIN_READ_CAPS: readonly CoreCapability[] = [
  'iam.users.read',
  'iam.users.manage',
]

// Admin write — user mutation.
const ADMIN_WRITE_CAPS: readonly CoreCapability[] = [
  'iam.users.manage',
]

// Role management.
const ROLE_MANAGE_CAPS: readonly CoreCapability[] = [
  'iam.roles.manage',
]

// ---------------------------------------------------------------------------
// Shared projections
// ---------------------------------------------------------------------------

function projectPublicUser(u: Awaited<ReturnType<typeof listUsers>>[number]) {
  return {
    id: u.id,
    email: u.email,
    displayName: u.displayName,
    status: u.status,
    role: { id: u.role.id, slug: u.role.slug, name: u.role.name },
    capabilities: u.capabilities,
    lastLoginAt: u.lastLoginAt,
    mfaEnabled: u.mfaEnabled,
    avatarUrl: u.avatarUrl,
    createdAt: u.createdAt,
    updatedAt: u.updatedAt,
  }
}

// ---------------------------------------------------------------------------
// admin_list_users
// ---------------------------------------------------------------------------

const listUsersTool: AiTool = {
  name: 'admin_list_users',
  scope: 'data',
  execution: 'server',
  requiredCapabilities: ADMIN_READ_CAPS,
  description:
    'List every active user in the project. Returns id, email, displayName, status, role (id/slug/name), capabilities, lastLoginAt, mfaEnabled, avatarUrl, and timestamps. No pagination — user lists are small (team-scale, not consumer-scale).',
  inputSchema: Type.Object({}),
  handler: async (_input, ctx) => {
    const users = await listUsers(ctx.db)
    return {
      total: users.length,
      users: users.map(projectPublicUser),
    }
  },
}

// ---------------------------------------------------------------------------
// admin_get_user
// ---------------------------------------------------------------------------

const GetUserInput = Type.Object({
  userId: Type.String({ minLength: 1 }),
})

const getUserTool: AiTool = {
  name: 'admin_get_user',
  scope: 'data',
  execution: 'server',
  requiredCapabilities: ADMIN_READ_CAPS,
  description:
    "Return one user's full profile: email, displayName, status, role, all capabilities, MFA status, avatar URL, Gravatar hash, and timestamps. Use before updating a user to see current state.",
  inputSchema: GetUserInput,
  handler: async (input, ctx) => {
    const { userId } = input as Static<typeof GetUserInput>
    const user = await findUserById(ctx.db, userId)
    if (!user) {
      return { ok: false, error: `User ${userId} not found.` }
    }
    return {
      user: {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        status: user.status,
        role: { id: user.role.id, slug: user.role.slug, name: user.role.name },
        capabilities: user.capabilities,
        lastLoginAt: user.lastLoginAt,
        mfaEnabled: user.mfaEnabled,
        avatarUrl: user.avatarUrl,
        gravatarHash: user.gravatarHash,
        passwordUpdatedAt: user.passwordUpdatedAt,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
      },
    }
  },
}

// ---------------------------------------------------------------------------
// admin_update_user
// ---------------------------------------------------------------------------

const UpdateUserInput = Type.Object({
  userId: Type.String({ minLength: 1 }),
  displayName: Type.Optional(Type.String()),
  email: Type.Optional(Type.String()),
  status: Type.Optional(Type.Union([
    Type.Literal('active'),
    Type.Literal('suspended'),
  ])),
  roleId: Type.Optional(Type.String()),
})

const updateUserTool: AiTool = {
  name: 'admin_update_user',
  scope: 'data',
  execution: 'server',
  requiredCapabilities: ADMIN_WRITE_CAPS,
  description:
    "Update a user's profile fields. `displayName` renames the user. `email` changes their login email (must be a valid email). `status` can be 'active' or 'suspended'. `roleId` reassigns their role (call admin_list_roles first for available role ids). All fields are optional — omit to leave unchanged. Cannot set passwords (use the reset-password UI).",
  inputSchema: UpdateUserInput,
  handler: async (input, ctx) => {
    const args = input as Static<typeof UpdateUserInput>
    try {
      const updated = await updateUser(ctx.db, args.userId, {
        displayName: args.displayName,
        email: args.email,
        status: args.status,
        roleId: args.roleId,
      })
      if (!updated) {
        return { ok: false, error: `User ${args.userId} not found.` }
      }
      return {
        ok: true,
        user: projectPublicUser(updated),
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { ok: false, error: message }
    }
  },
}

// ---------------------------------------------------------------------------
// admin_list_roles
// ---------------------------------------------------------------------------

const listRolesTool: AiTool = {
  name: 'admin_list_roles',
  scope: 'data',
  execution: 'server',
  requiredCapabilities: ADMIN_READ_CAPS,
  description:
    'List every role in the project (system + custom). Returns id, slug, name, description, isSystem, capabilities (full grant list), and timestamps. Use to discover available roleIds before assigning or creating roles.',
  inputSchema: Type.Object({}),
  handler: async (_input, ctx) => {
    const roles = await listRoles(ctx.db)
    return {
      total: roles.length,
      roles: roles.map((r) => ({
        id: r.id,
        slug: r.slug,
        name: r.name,
        description: r.description,
        isSystem: r.isSystem,
        capabilities: r.capabilities,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      })),
    }
  },
}

// ---------------------------------------------------------------------------
// admin_create_role
// ---------------------------------------------------------------------------

const CreateRoleInput = Type.Object({
  name: Type.String({ minLength: 1 }),
  description: Type.String(),
  slug: Type.Optional(Type.String()),
  capabilities: Type.Array(Type.String(), { minItems: 1 }),
})

const createRoleTool: AiTool = {
  name: 'admin_create_role',
  scope: 'data',
  execution: 'server',
  requiredCapabilities: ROLE_MANAGE_CAPS,
  description:
    "Create a custom role. `name` is the human-readable label. `slug` is auto-derived if omitted. `description` explains what the role grants. `capabilities` is a string array of capability ids — call admin_list_roles first and inspect an existing role's capabilities array for the available ids. Returns the created role.",
  inputSchema: CreateRoleInput,
  handler: async (input, ctx) => {
    const args = input as Static<typeof CreateRoleInput>
    try {
      const role = await createCustomRole(ctx.db, {
        name: args.name,
        slug: args.slug,
        description: args.description,
        capabilities: args.capabilities as CoreCapability[],
      })
      return {
        ok: true,
        role: {
          id: role.id,
          slug: role.slug,
          name: role.name,
          description: role.description,
          isSystem: role.isSystem,
          capabilities: role.capabilities,
          createdAt: role.createdAt,
          updatedAt: role.updatedAt,
        },
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { ok: false, error: message }
    }
  },
}

// ---------------------------------------------------------------------------
// Barrel
// ---------------------------------------------------------------------------

export const adminTools: AiTool[] = [
  listUsersTool,
  getUserTool,
  updateUserTool,
  listRolesTool,
  createRoleTool,
]
