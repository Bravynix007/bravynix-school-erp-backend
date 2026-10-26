import type { AccountRow, SeatHolder } from './account.repository.js';
import { reportedStatus } from './auth-codes.js';
import { personName } from './person-name.js';

/** A person as the platform endpoints show them (API design 10.4d). A Pending account is shown as Active (10.2). */
export interface AccountResource {
  id: string;
  email: string;
  displayName: string;
  accountStatus: number;
  blockedAt: string | null;
  blockReason: string | null;
  version: number;
}

/** A Super Admin: the account and the seat, and whether the authenticator is set up (PLT-12). */
export interface SuperAdminResource extends AccountResource {
  seatNo: number;
  authenticatorSetUp: boolean;
  grantedAt: string;
}

export function accountResource(user: AccountRow): AccountResource {
  return {
    id: user.id,
    email: user.email,
    displayName: personName(user.first_name, user.last_name) ?? user.email,
    accountStatus: reportedStatus(user.account_status),
    blockedAt: user.blocked_at?.toISOString() ?? null,
    blockReason: user.block_reason,
    version: user.version,
  };
}

export function superAdminResource(
  holder: SeatHolder,
  authenticatorSetUp: boolean,
): SuperAdminResource {
  return {
    ...accountResource(holder.user),
    seatNo: holder.seatNo,
    authenticatorSetUp,
    grantedAt: holder.grantedAt.toISOString(),
  };
}
