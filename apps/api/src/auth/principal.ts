import type { Environment, Role } from '@connect/shared';

/**
 * The authenticated caller of an API request.
 *
 * - `user`: dashboard session (better-auth cookie); org resolved from the
 *   x-connect-org header + membership.
 * - `access_token`: PAT (`cn_pat_…`); bound to one org, acts with its
 *   creator's role (or admin for org tokens).
 * - `workload`: Connect-issued OIDC JWT; bound to one project + environment,
 *   may ONLY request tokens.
 */
export type Principal =
  | { kind: 'user'; actorId: string; orgId: string; role: Role }
  | { kind: 'access_token'; actorId: string; orgId: string; role: Role }
  | {
      kind: 'workload';
      actorId: string;
      orgId: string;
      projectId: string;
      environment: Environment;
    };

const ROLE_RANK: Record<Role, number> = { member: 0, admin: 1, owner: 2 };

export function hasRole(principal: Principal, min: Role): boolean {
  if (principal.kind === 'workload') return false;
  return ROLE_RANK[principal.role] >= ROLE_RANK[min];
}
