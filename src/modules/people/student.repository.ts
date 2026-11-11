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
import type {
  StudentEnrolmentsTable,
  StudentGuardiansTable,
  StudentSectionPlacementsTable,
  StudentsTable,
} from './people.tables.js';
import type { StudentSortField } from './student.dto.js';

export type StudentRow = Selectable<StudentsTable>;
export type NewStudent = Insertable<StudentsTable>;
export type GuardianRow = Selectable<StudentGuardiansTable>;
export type NewGuardian = Insertable<StudentGuardiansTable>;
export type EnrolmentRow = Selectable<StudentEnrolmentsTable>;
export type NewEnrolment = Insertable<StudentEnrolmentsTable>;
export type PlacementRow = Selectable<StudentSectionPlacementsTable>;
export type NewPlacement = Insertable<StudentSectionPlacementsTable>;
export type StudentChanges = Updateable<StudentsTable>;
export type PlacementChanges = Updateable<StudentSectionPlacementsTable>;
export type EnrolmentChanges = Updateable<StudentEnrolmentsTable>;

/** A student's placement with the enrolment it belongs to: where the child sits, and since when. */
export interface PlacedRow {
  placement_id: string;
  enrolment_id: string;
  academic_year_id: string;
  class_id: string;
  section_id: string;
  roll_number: string;
  start_date: string;
  enrolled_date: string;
}

/** What STU-01 asks for: only students of one of `institutionIds`, shown with their placement in `academicYearId`. */
export interface StudentFilter {
  q?: string;
  institutionIds: readonly string[];
  statuses: readonly number[];
  academicYearId?: string;
  classId?: string;
  sectionId?: string;
}

/** A student with the placement a list shows. */
export type StudentListRow = StudentRow & PlacedRow;

/** What a placement shows, read from `student_section_placements as p` joined to `student_enrolments as e`. */
const PLACED_COLUMNS = [
  'p.id as placement_id',
  'e.id as enrolment_id',
  'p.academic_year_id',
  'p.class_id',
  'p.section_id',
  'p.roll_number',
  'p.start_date',
  'e.enrolled_date',
] as const;

/** The student's name as lists order it: first and last name, ignoring letter case. */
const STUDENT_NAME = sql`lower(concat_ws(' ', students.first_name, students.last_name))`;
const SORT_COLUMN = {
  name: STUDENT_NAME,
  admissionNo: sql`lower(students.admission_no)`,
  // Numbers in numeric order, then the rest in text order: "9" before "10", "A1" after both.
  rollNumber: sql`(pl.roll_number !~ '^[0-9]+$')::int::text || lpad(pl.roll_number, 20, '0')`,
  createdAt: sql`students.created_at`,
} as const;

/** Queries on the student tables; every one runs in the caller's transaction, under row-level security. */
@Injectable()
export class StudentRepository {
  async find(tx: Tx, id: string, lock = false): Promise<StudentRow | undefined> {
    const query = tx.selectFrom('students').selectAll().where('id', '=', id);
    return (lock ? query.forUpdate() : query).executeTakeFirst();
  }

  insert(tx: Tx, values: NewStudent): Promise<StudentRow> {
    return tx.insertInto('students').values(values).returningAll().executeTakeFirstOrThrow();
  }

  update(tx: Tx, id: string, changes: StudentChanges): Promise<StudentRow> {
    return tx
      .updateTable('students')
      .set(changes)
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  insertEnrolment(tx: Tx, values: NewEnrolment): Promise<EnrolmentRow> {
    return tx
      .insertInto('student_enrolments')
      .values(values)
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  insertPlacement(tx: Tx, values: NewPlacement): Promise<PlacementRow> {
    return tx
      .insertInto('student_section_placements')
      .values(values)
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  /** Ends or cancels an enrolment: the day the child left and the outcome, or `status` 0 for one made by mistake. */
  async updateEnrolment(tx: Tx, id: string, changes: EnrolmentChanges): Promise<void> {
    await tx.updateTable('student_enrolments').set(changes).where('id', '=', id).execute();
  }

  async updatePlacement(tx: Tx, id: string, changes: PlacementChanges): Promise<void> {
    await tx.updateTable('student_section_placements').set(changes).where('id', '=', id).execute();
  }

  async insertGuardians(tx: Tx, rows: NewGuardian[]): Promise<GuardianRow[]> {
    return tx.insertInto('student_guardians').values(rows).returningAll().execute();
  }

  /** The active guardians, the primary first. */
  guardians(tx: Tx, studentId: string): Promise<GuardianRow[]> {
    return tx
      .selectFrom('student_guardians')
      .selectAll()
      .where('student_id', '=', studentId)
      .where('status', '=', 1)
      .orderBy('is_primary', 'desc')
      .orderBy('created_at')
      .orderBy('id')
      .execute();
  }

  /**
   * The placement the student sits in now, or the latest they had: the one a profile shows. A deactivated student
   * keeps showing the last one, though an enrolment made by mistake is cancelled.
   */
  placedNow(tx: Tx, studentId: string): Promise<PlacedRow | undefined> {
    return tx
      .selectFrom('student_section_placements as p')
      .innerJoin('student_enrolments as e', 'e.id', 'p.student_enrolment_id')
      .select(PLACED_COLUMNS)
      .where('e.student_id', '=', studentId)
      .orderBy('p.start_date', 'desc')
      .orderBy('p.id', 'desc')
      .limit(1)
      .executeTakeFirst();
  }

  /**
   * The placement that is open now: the one STU-08 closes. None for a student without an active enrolment or whose
   * placement was closed.
   */
  openPlacement(tx: Tx, studentId: string): Promise<PlacedRow | undefined> {
    return tx
      .selectFrom('student_section_placements as p')
      .innerJoin('student_enrolments as e', 'e.id', 'p.student_enrolment_id')
      .select(PLACED_COLUMNS)
      .where('e.student_id', '=', studentId)
      .where('e.status', '=', 1)
      .where('p.end_date', 'is', null)
      .executeTakeFirst();
  }

  /** How many students sit in the section now, in the year: the count a capacity warning compares. */
  async sectionCount(tx: Tx, academicYearId: string, sectionId: string): Promise<number> {
    const { total } = await tx
      .selectFrom('student_section_placements')
      .select((eb) => eb.fn.countAll<number>().as('total'))
      .where('academic_year_id', '=', academicYearId)
      .where('section_id', '=', sectionId)
      .where('end_date', 'is', null)
      .executeTakeFirstOrThrow();
    return Number(total);
  }

  /** Students of the filter, each with the placement shown: the year named, else the latest. */
  private listed(tx: Tx, filter: StudentFilter) {
    return tx
      .selectFrom('students')
      .innerJoinLateral(
        (eb) =>
          eb
            .selectFrom('student_section_placements as p')
            .innerJoin('student_enrolments as e', 'e.id', 'p.student_enrolment_id')
            .select(PLACED_COLUMNS)
            .whereRef('e.student_id', '=', 'students.id')
            .$if(filter.academicYearId !== undefined, (qb) =>
              qb.where('p.academic_year_id', '=', filter.academicYearId!),
            )
            .orderBy('p.start_date', 'desc')
            .orderBy('p.id', 'desc')
            .limit(1)
            .as('pl'),
        (join) => join.onTrue(),
      )
      .where(this.matching(filter));
  }

  private matching(filter: StudentFilter) {
    return (eb: ExpressionBuilder<Database & { pl: PlacedRow }, 'students' | 'pl'>) => {
      const conditions = [
        eb('students.institution_id', 'in', filter.institutionIds),
        eb('students.status', 'in', filter.statuses),
      ];
      if (filter.classId) conditions.push(eb('pl.class_id', '=', filter.classId));
      if (filter.sectionId) conditions.push(eb('pl.section_id', '=', filter.sectionId));
      if (filter.q) {
        const pattern = containsPattern(filter.q.toLowerCase());
        conditions.push(
          eb.or([
            eb('students.search_text', 'like', pattern),
            eb(sql`lower(pl.roll_number)`, 'like', pattern),
          ]),
        );
      }
      return eb.and(conditions);
    };
  }

  /** One page of STU-01, with the total. No Institution to look in is no rows. */
  async page(
    tx: Tx,
    filter: StudentFilter,
    sort: readonly SortKey<StudentSortField>[],
    limit: number,
    offset: number,
  ): Promise<{ rows: StudentListRow[]; total: number }> {
    if (filter.institutionIds.length === 0 || filter.statuses.length === 0) {
      return { rows: [], total: 0 };
    }
    let query = this.listed(tx, filter)
      .selectAll('students')
      .select([
        'pl.placement_id',
        'pl.enrolment_id',
        'pl.academic_year_id',
        'pl.class_id',
        'pl.section_id',
        'pl.roll_number',
        'pl.start_date',
        'pl.enrolled_date',
      ]);
    // A student without an Admission ID or roll number sorts last in either direction.
    for (const key of sort) {
      query = query.orderBy(SORT_COLUMN[key.field], (order) =>
        key.direction === 'asc' ? order.asc().nullsLast() : order.desc().nullsLast(),
      );
    }
    const rows = await query.orderBy('students.id').limit(limit).offset(offset).execute();
    const { total } = await this.listed(tx, filter)
      .select((eb) => eb.fn.countAll<number>().as('total'))
      .executeTakeFirstOrThrow();
    return { rows, total: Number(total) };
  }
}
