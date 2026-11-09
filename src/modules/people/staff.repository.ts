import { Injectable } from '@nestjs/common';
import type { Insertable, Selectable, Updateable } from 'kysely';
import type { Tx } from '../../platform/database/index.js';
import type {
  StaffEducationsTable,
  StaffEmergencyContactsTable,
  StaffMembersTable,
} from './people.tables.js';

export type StaffRow = Selectable<StaffMembersTable>;
export type NewStaff = Insertable<StaffMembersTable>;
export type StaffChanges = Updateable<StaffMembersTable>;
export type EducationRow = Selectable<StaffEducationsTable>;
export type NewEducation = Insertable<StaffEducationsTable>;
export type EmergencyContactRow = Selectable<StaffEmergencyContactsTable>;
export type NewEmergencyContact = Insertable<StaffEmergencyContactsTable>;

/** Queries on the staff tables; every one runs in the caller's transaction, under row-level security. */
@Injectable()
export class StaffRepository {
  async find(tx: Tx, id: string, lock = false): Promise<StaffRow | undefined> {
    const query = tx.selectFrom('staff_members').selectAll().where('id', '=', id);
    return (lock ? query.forUpdate() : query).executeTakeFirst();
  }

  insert(tx: Tx, values: NewStaff): Promise<StaffRow> {
    return tx.insertInto('staff_members').values(values).returningAll().executeTakeFirstOrThrow();
  }

  update(tx: Tx, id: string, changes: StaffChanges): Promise<StaffRow> {
    return tx
      .updateTable('staff_members')
      .set(changes)
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  educations(tx: Tx, staffId: string): Promise<EducationRow[]> {
    return tx
      .selectFrom('staff_educations')
      .selectAll()
      .where('staff_member_id', '=', staffId)
      .orderBy('year_of_passing', (order) => order.desc().nullsLast())
      .orderBy('degree')
      .orderBy('id')
      .execute();
  }

  emergencyContacts(tx: Tx, staffId: string): Promise<EmergencyContactRow[]> {
    return tx
      .selectFrom('staff_emergency_contacts')
      .selectAll()
      .where('staff_member_id', '=', staffId)
      .orderBy('is_primary', 'desc')
      .orderBy('contact_name')
      .orderBy('id')
      .execute();
  }

  /** The lists are replaced whole: the old rows go, the new ones are written. */
  async replaceEducations(tx: Tx, staffId: string, rows: NewEducation[]): Promise<void> {
    await tx.deleteFrom('staff_educations').where('staff_member_id', '=', staffId).execute();
    if (rows.length > 0) await tx.insertInto('staff_educations').values(rows).execute();
  }

  async replaceEmergencyContacts(
    tx: Tx,
    staffId: string,
    rows: NewEmergencyContact[],
  ): Promise<void> {
    await tx
      .deleteFrom('staff_emergency_contacts')
      .where('staff_member_id', '=', staffId)
      .execute();
    if (rows.length > 0) await tx.insertInto('staff_emergency_contacts').values(rows).execute();
  }
}
