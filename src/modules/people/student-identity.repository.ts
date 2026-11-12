import { Injectable } from '@nestjs/common';
import { sql, type Selectable } from 'kysely';
import type { Tx } from '../../platform/database/index.js';
import type { ProtectedAadhaar } from '../../platform/identity-numbers/index.js';
import type { StudentIdentitiesTable } from './people.tables.js';

export type StudentIdentityRow = Selectable<StudentIdentitiesTable>;

/** The student of the same Institution who holds a number, and whether that record is still active. */
export interface StudentNumberHolder {
  studentId: string;
  status: number;
}

/** What a write sets: a field left out stays as it is, `null` clears it. */
export interface StudentIdentityValues {
  aadhaar?: ProtectedAadhaar | null;
  birthCertificateNumber?: string | null;
}

/** Queries on `student_identities` (DDD 9.6); every one runs in the caller's transaction, under row-level security. */
@Injectable()
export class StudentIdentityRepository {
  find(tx: Tx, studentId: string): Promise<StudentIdentityRow | undefined> {
    return tx
      .selectFrom('student_identities')
      .selectAll()
      .where('student_id', '=', studentId)
      .executeTakeFirst();
  }

  /** The other student of this Institution whose Aadhaar has this hash, with the status of that student. */
  async holderOf(
    tx: Tx,
    institutionId: string,
    hmac: Buffer,
    studentId: string,
  ): Promise<StudentNumberHolder | undefined> {
    const row = await tx
      .selectFrom('student_identities as i')
      .innerJoin('students as s', 's.id', 'i.student_id')
      .select(['i.student_id', 's.status'])
      .where('i.institution_id', '=', institutionId)
      .where('i.aadhaar_hmac', '=', hmac)
      .where('i.student_id', '<>', studentId)
      .executeTakeFirst();
    return row && { studentId: row.student_id, status: row.status };
  }

  /** Does a student of another Institution of the caller's Society hold this number? A definer function answers. */
  async heldElsewhere(tx: Tx, institutionId: string, hmac: Buffer): Promise<boolean> {
    const { rows } = await sql<{
      held: boolean;
    }>`select app_student_aadhaar_elsewhere(${institutionId}::uuid, ${hmac}) as held`.execute(tx);
    return rows[0]?.held === true;
  }

  /** Sets what `values` names and leaves the rest; the row is made on the first write and kept after. */
  async put(
    tx: Tx,
    slot: { studentId: string; societyId: string; institutionId: string; by: string },
    values: StudentIdentityValues,
  ): Promise<void> {
    const columns = {
      ...(values.aadhaar !== undefined && {
        aadhaar_ciphertext: values.aadhaar?.ciphertext ?? null,
        aadhaar_key_version: values.aadhaar?.keyVersion ?? null,
        aadhaar_hmac: values.aadhaar?.hmac ?? null,
        aadhaar_last4: values.aadhaar?.last4 ?? null,
      }),
      ...(values.birthCertificateNumber !== undefined && {
        birth_certificate_number: values.birthCertificateNumber,
      }),
    };
    await tx
      .insertInto('student_identities')
      .values({
        student_id: slot.studentId,
        society_id: slot.societyId,
        institution_id: slot.institutionId,
        created_by: slot.by,
        updated_by: slot.by,
        ...columns,
      })
      .onConflict((conflict) =>
        conflict.column('student_id').doUpdateSet({ ...columns, updated_by: slot.by }),
      )
      .execute();
  }
}
