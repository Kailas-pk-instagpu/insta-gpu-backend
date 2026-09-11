import { ForbiddenException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { Pool } from 'pg';

export type UserRole = 'super_admin' | 'admin' | 'cafe_owner' | 'manager';

export const VALID_ROLES: UserRole[] = ['super_admin', 'admin', 'cafe_owner', 'manager'];

export function isValidRole(role?: string): role is UserRole {
  return typeof role === 'string' && VALID_ROLES.includes(role as UserRole);
}

export interface UserContext {
  id: string;
  role: UserRole;
  cafeId: string | null;
  branchId: string | null;
}

export async function getUserContext(pool: Pool, userId?: string, roleHeader?: string): Promise<UserContext> {
  if (!userId) {
    throw new UnauthorizedException('Missing x-user-id header');
  }

  const { rows } = await pool.query<{ id: string; role: string; cafe_id: string | null; branch_id: string | null }>(
    `SELECT id, role, cafe_id, branch_id FROM users WHERE id = $1`,
    [userId],
  );

  const role = (roleHeader && isValidRole(roleHeader) ? roleHeader : rows[0]?.role) as UserRole;
  if (!isValidRole(role)) {
    throw new ForbiddenException(`Invalid or unauthorized role: ${roleHeader || rows[0]?.role}`);
  }

  return {
    id: userId,
    role,
    cafeId: rows[0]?.cafe_id ?? null,
    branchId: rows[0]?.branch_id ?? null,
  };
}

export interface SqlFilter {
  clause: string;
  params: any[];
}

export function buildBranchRoleFilter(user: UserContext, paramStartIndex = 1): SqlFilter {
  if (user.role === 'super_admin') {
    return { clause: '1=1', params: [] };
  }

  if (user.role === 'admin') {
    if (user.cafeId) {
      return {
        clause: `(b.admin_id = $${paramStartIndex} OR (b.cafe_id IS NOT NULL AND b.cafe_id = $${paramStartIndex + 1}))`,
        params: [user.id, user.cafeId],
      };
    }
    return {
      clause: `(b.admin_id = $${paramStartIndex})`,
      params: [user.id],
    };
  }

  if (user.role === 'cafe_owner') {
    if (user.cafeId) {
      return {
        clause: `(b.cafe_owner_id = $${paramStartIndex} OR b.owner_id = $${paramStartIndex} OR (b.cafe_id IS NOT NULL AND b.cafe_id = $${paramStartIndex + 1}))`,
        params: [user.id, user.cafeId],
      };
    }
    return {
      clause: `(b.cafe_owner_id = $${paramStartIndex} OR b.owner_id = $${paramStartIndex})`,
      params: [user.id],
    };
  }

  if (user.role === 'manager') {
    if (user.branchId) {
      return {
        clause: `(b.manager_id = $${paramStartIndex} OR b.id = $${paramStartIndex + 1})`,
        params: [user.id, user.branchId],
      };
    }
    return {
      clause: `(b.manager_id = $${paramStartIndex})`,
      params: [user.id],
    };
  }

  throw new ForbiddenException(`Role not permitted`);
}

export async function assertBranchAccess(pool: Pool, user: UserContext, branchId: string): Promise<any> {
  const { rows } = await pool.query(
    `SELECT id, name, location, address, cafe_id, status, owner_id, cafe_owner_id, admin_id, manager_id,
            total_seats, hourly_rate, currency, daily_spend_limit, created_at, updated_at
     FROM branches WHERE id = $1`,
    [branchId],
  );

  if (!rows.length) {
    throw new NotFoundException(`Branch not found with id ${branchId}`);
  }

  const branch = rows[0];
  if (user.role === 'super_admin') {
    return branch;
  }

  if (user.role === 'admin') {
    const matchesAdmin = branch.admin_id === user.id;
    const matchesCafe = user.cafeId && branch.cafe_id === user.cafeId;
    if (matchesAdmin || matchesCafe) return branch;
  }

  if (user.role === 'cafe_owner') {
    const matchesOwner = branch.cafe_owner_id === user.id || branch.owner_id === user.id;
    const matchesCafe = user.cafeId && branch.cafe_id === user.cafeId;
    if (matchesOwner || matchesCafe) return branch;
  }

  if (user.role === 'manager') {
    const matchesManager = branch.manager_id === user.id;
    const matchesBranch = user.branchId && branch.id === user.branchId;
    if (matchesManager || matchesBranch) return branch;
  }

  throw new ForbiddenException(`Access to branch denied for role ${user.role}`);
}
