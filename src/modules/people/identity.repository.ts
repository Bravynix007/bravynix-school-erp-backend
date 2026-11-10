import { Injectable } from '@nestjs/common';
import type { Selectable } from 'kysely';
import type { ProtectedAadhaar } from '../../platform/identity-numbers/index.js';
import type { Tx } from '../../platform/database/index.js';
import type { StaffIdentitiesTable } from './people.tables.js';

export type IdentityRow = Selectable<StaffIdentitiesTable>;

/** The staff member who holds a number, the Institution of that record and whether it is still active. */
export interface NumberHolder {
  staffMemberId: string;
  homeInstitutionId: string;
  status: number;
}

/** Queries on `staff_identities` (DDD 9.5); every one runs in the caller's transaction, under row-level security. */
@Injectable()
export class IdentityRepository {
  find(tx: Tx, staffMemberId: string): Promise<IdentityRow | undefined> {
    return tx
      .selectFrom('staff_identities')
      .selectAll()
      .where('staff_member_id', '=', staffMemberId)
      .executeTakeFirst();
  }

  /** The record, other than `staffMemberId`, whose Aadhaar has this hash, with its home Institution and status. */
  async holderOf(tx: Tx, hmac: Buffer, staffMemberId: string): Promise<NumberHolder | undefined> {
    const row = await tx
      .selectFrom('staff_identities as i')
      .innerJoin('staff_members as s', 's.id', 'i.staff_member_id')
      .select(['i.staff_member_id', 's.home_institution_id', 's.status'])
      .where('i.aadhaar_hmac', '=', hmac)
      .where('i.staff_member_id', '<>', staffMemberId)
      .executeTakeFirst();
    return (
      row && {
        staffMemberId: row.staff_member_id,
        homeInstitutionId: row.home_institution_id,
        status: row.status,
      }
    );
  }

  /** Sets the number, or clears it with `null`; the row is made on the first write and kept after. */
  async put(
    tx: Tx,
    slot: { staffMemberId: string; societyId: string; by: string },
    value: ProtectedAadhaar | null,
  ): Promise<void> {
    const columns = {
      aadhaar_ciphertext: value?.ciphertext ?? null,
      aadhaar_key_version: value?.keyVersion ?? null,
      aadhaar_hmac: value?.hmac ?? null,
      aadhaar_last4: value?.last4 ?? null,
    };
    await tx
      .insertInto('staff_identities')
      .values({
        staff_member_id: slot.staffMemberId,
        society_id: slot.societyId,
        created_by: slot.by,
        updated_by: slot.by,
        ...columns,
      })
      .onConflict((conflict) =>
        conflict.column('staff_member_id').doUpdateSet({ ...columns, updated_by: slot.by }),
      )
      .execute();
  }
}
