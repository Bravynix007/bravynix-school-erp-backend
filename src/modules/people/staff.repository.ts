import { Injectable } from '@nestjs/common';
import {
  sql,
  type ExpressionBuilder,
  type Insertable,
  type Selectable,
  type Updateable,
} from 'kysely';
import { containsPattern, type SortKey } from '../../common/pagination/pagination.js';
import type { Database, Tx } from '../../platform/database/index.js';
import type { StaffSortField } from './staff.dto.js';
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

/** What STF-01 asks for: only staff whose home Institution is one of `institutionIds`. */
export interface StaffFilter {
  q?: string;
  institutionIds: readonly string[];
  statuses: readonly number[];
  designationId?: string;
  classCategoryId?: string;
}

const NAME = sql`lower(concat_ws(' ', staff_members.first_name, staff_members.last_name))`;
const SORT_COLUMN = {
  name: NAME,
  employeeCode: sql`lower(staff_members.employee_code)`,
  joiningDate: sql`staff_members.joining_date`,
  createdAt: sql`staff_members.created_at`,
} as const;

/** Queries on the staff tables; every one runs in the caller's transaction, under row-level security. */
@Injectable()
export class StaffRepository {
  async find(tx: Tx, id: string, lock = false): Promise<StaffRow | undefined> {
    const query = tx.selectFrom('staff_members').selectAll().where('id', '=', id);
    return (lock ? query.forUpdate() : query).executeTakeFirst();
  }

  private matching(filter: StaffFilter) {
    return (eb: ExpressionBuilder<Database, 'staff_members'>) => {
      const conditions = [
        eb('staff_members.home_institution_id', 'in', filter.institutionIds),
        eb('staff_members.status', 'in', filter.statuses),
      ];
      if (filter.q) {
        const pattern = containsPattern(filter.q);
        conditions.push(
          eb.or([
            sql<boolean>`concat_ws(' ', staff_members.first_name, staff_members.last_name) ilike ${pattern}`,
            eb('staff_members.employee_code', 'ilike', pattern),
          ]),
        );
      }
      if (filter.designationId) {
        conditions.push(eb('staff_members.designation_id', '=', filter.designationId));
      }
      if (filter.classCategoryId) {
        conditions.push(eb('staff_members.class_category_id', '=', filter.classCategoryId));
      }
      return eb.and(conditions);
    };
  }

  /** One page of STF-01, with the total. No Institution to look in is no rows. */
  async page(
    tx: Tx,
    filter: StaffFilter,
    sort: readonly SortKey<StaffSortField>[],
    limit: number,
    offset: number,
  ): Promise<{ rows: StaffRow[]; total: number }> {
    if (filter.institutionIds.length === 0 || filter.statuses.length === 0) {
      return { rows: [], total: 0 };
    }
    let query = tx.selectFrom('staff_members').selectAll().where(this.matching(filter));
    // A member without an Employee ID or joining date sorts last in either direction.
    for (const key of sort) {
      query = query.orderBy(SORT_COLUMN[key.field], (order) =>
        key.direction === 'asc' ? order.asc().nullsLast() : order.desc().nullsLast(),
      );
    }
    const rows = await query.orderBy('staff_members.id').limit(limit).offset(offset).execute();
    const { total } = await tx
      .selectFrom('staff_members')
      .select((eb) => eb.fn.countAll<number>().as('total'))
      .where(this.matching(filter))
      .executeTakeFirstOrThrow();
    return { rows, total: Number(total) };
  }

  /** Does this person have an active record in the Society? */
  async hasActiveRecord(tx: Tx, userId: string, societyId: string): Promise<boolean> {
    const row = await tx
      .selectFrom('staff_members')
      .select('id')
      .where('user_id', '=', userId)
      .where('society_id', '=', societyId)
      .where('status', '=', 1)
      .executeTakeFirst();
    return row !== undefined;
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
