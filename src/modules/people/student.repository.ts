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
  /** Only students whose placement is in one of these sections (a teacher's own); none listed is no student. */
  inSectionIds?: readonly string[];
  /** Only placements of these years (a teacher's current years); none listed is no student. */
  inYearIds?: readonly string[];
  /** Search the name and roll number only, never the Admission ID (the classroom view hides it). */
  searchNameAndRollOnly?: boolean;
}

/** What PRM-01 and STU-09 promote from: the students placed in a class (and a section) in a year. */
export interface PromotionSource {
  academicYearId: string;
  classId: string;
  /** `null` is every section of the class. */
  sectionId: string | null;
  /** Only these students; every student placed there without it. */
  studentIds?: readonly string[];
}

/** A student at the placement a promotion closes. */
export interface PromotableRow {
  student_id: string;
  institution_id: string;
  society_id: string;
  enrolment_id: string;
  placement_id: string;
  section_id: string;
  roll_number: string;
  start_date: string;
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
  // Numbers in numeric order, then the rest in text order, ignoring letter case: "9" before "10", "A1" after both.
  rollNumber: sql`case when pl.roll_number ~ '^[0-9]+$' then '0' || lpad(pl.roll_number, 20, '0') else '1' || lower(pl.roll_number) end`,
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

  /** Deactivates the students who completed the final class; the caller holds their rows locked. */
  async markCompleted(
    tx: Tx,
    ids: readonly string[],
    values: Pick<StudentChanges, 'inactive_reason' | 'inactive_at' | 'updated_by'>,
  ): Promise<void> {
    await tx
      .updateTable('students')
      .set({ ...values, status: 0 })
      .where('id', 'in', ids)
      .execute();
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

  /**
   * Lets the key between a placement and its enrolment's class be checked when the transaction commits, so the class
   * of the enrolment and of its placements change together (STU-12).
   */
  async deferPlacementClassKey(tx: Tx): Promise<void> {
    await sql`set constraints fk_placements_enrolment_class deferred`.execute(tx);
  }

  /** Changes every placement of the enrolment but one: the ones STU-12 leaves behind in the class it corrects. */
  async updateOtherPlacements(
    tx: Tx,
    enrolmentId: string,
    exceptId: string,
    changes: PlacementChanges,
  ): Promise<void> {
    await tx
      .updateTable('student_section_placements')
      .set(changes)
      .where('student_enrolment_id', '=', enrolmentId)
      .where('id', '!=', exceptId)
      .execute();
  }

  /**
   * The enrolment this one followed: the latest other enrolment of the student that a promotion ended as Promoted or
   * Repeating. None for a student admitted into this year.
   */
  previousEnrolment(
    tx: Tx,
    studentId: string,
    enrolmentId: string,
  ): Promise<Pick<EnrolmentRow, 'id' | 'class_id' | 'outcome'> | undefined> {
    return tx
      .selectFrom('student_enrolments')
      .select(['id', 'class_id', 'outcome'])
      .where('student_id', '=', studentId)
      .where('status', '=', 1)
      .where('id', '!=', enrolmentId)
      .where('outcome', 'in', [1, 2])
      .orderBy('enrolled_date', 'desc')
      .limit(1)
      .executeTakeFirst();
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

  /** The students of the source whose placement is open, with every filter of a promotion applied. */
  private inSource(tx: Tx, source: PromotionSource) {
    let query = tx
      .selectFrom('student_section_placements as p')
      .innerJoin('student_enrolments as e', 'e.id', 'p.student_enrolment_id')
      .innerJoin('students as s', 's.id', 'e.student_id')
      .where('s.status', '=', 1)
      .where('e.status', '=', 1)
      .where('p.end_date', 'is', null)
      .where('p.academic_year_id', '=', source.academicYearId)
      .where('p.class_id', '=', source.classId);
    if (source.sectionId !== null) query = query.where('p.section_id', '=', source.sectionId);
    if (source.studentIds !== undefined) query = query.where('s.id', 'in', source.studentIds);
    return query;
  }

  /**
   * The active students whose open placement is in the source class (and section) of the year, their rows locked until
   * the transaction ends, so two promotions of the same students run one after the other.
   *
   * The students are locked first and the placements read after, in a statement of their own: after a lock wait
   * Postgres checks again only the rows it locked, so a placement read in the same statement could have been closed
   * or moved by the change that held the lock. Every writer of placements (STU-05, STU-08, STU-09, PRM-01) locks the
   * student first, so what is read under the lock stands.
   */
  async promotable(tx: Tx, source: PromotionSource): Promise<PromotableRow[]> {
    const candidates = await this.inSource(tx, source)
      .select('s.id')
      .orderBy('s.id')
      .forUpdate(['s'])
      .execute();
    if (candidates.length === 0) return [];
    return this.inSource(tx, { ...source, studentIds: candidates.map((row) => row.id) })
      .select([
        's.id as student_id',
        's.institution_id',
        's.society_id',
        'e.id as enrolment_id',
        'p.id as placement_id',
        'p.section_id',
        'p.roll_number',
        'p.start_date',
      ])
      .orderBy('s.id')
      .execute();
  }

  /** Which of these students already hold an active enrolment in the year. */
  async enrolledIn(
    tx: Tx,
    academicYearId: string,
    studentIds: readonly string[],
  ): Promise<Set<string>> {
    if (studentIds.length === 0) return new Set();
    const rows = await tx
      .selectFrom('student_enrolments')
      .select('student_id')
      .where('status', '=', 1)
      .where('academic_year_id', '=', academicYearId)
      .where('student_id', 'in', studentIds)
      .execute();
    return new Set(rows.map((row) => row.student_id));
  }

  /** The roll numbers now held in the section in the year: the open placements. */
  async rollNumbersIn(tx: Tx, academicYearId: string, sectionId: string): Promise<string[]> {
    const rows = await tx
      .selectFrom('student_section_placements')
      .select('roll_number')
      .where('academic_year_id', '=', academicYearId)
      .where('section_id', '=', sectionId)
      .where('end_date', 'is', null)
      .execute();
    return rows.map((row) => row.roll_number);
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

  /** The students now in each of these sections, in any year: the open placements. A section with none is left out. */
  async sectionCounts(tx: Tx, sectionIds: readonly string[]): Promise<Map<string, number>> {
    if (sectionIds.length === 0) return new Map();
    const rows = await tx
      .selectFrom('student_section_placements')
      .select(['section_id', (eb) => eb.fn.countAll<number>().as('total')])
      .where('section_id', 'in', sectionIds)
      .where('end_date', 'is', null)
      .groupBy('section_id')
      .execute();
    return new Map(rows.map((row) => [row.section_id, Number(row.total)]));
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
            .$if(filter.inYearIds !== undefined, (qb) =>
              qb.where('p.academic_year_id', 'in', filter.inYearIds!),
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
      if (filter.inSectionIds) conditions.push(eb('pl.section_id', 'in', filter.inSectionIds));
      if (filter.q) {
        const pattern = containsPattern(filter.q.toLowerCase());
        conditions.push(
          eb.or([
            filter.searchNameAndRollOnly
              ? eb(
                  sql`lower(students.first_name || ' ' || coalesce(students.last_name, ''))`,
                  'like',
                  pattern,
                )
              : eb('students.search_text', 'like', pattern),
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
    if (
      filter.institutionIds.length === 0 ||
      filter.statuses.length === 0 ||
      filter.inSectionIds?.length === 0 ||
      filter.inYearIds?.length === 0
    ) {
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
