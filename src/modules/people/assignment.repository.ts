import { Injectable } from '@nestjs/common';
import type { Insertable, Selectable } from 'kysely';
import type { Tx } from '../../platform/database/index.js';
import type { ClassTeacherAssignmentsTable, TeachingAssignmentsTable } from './people.tables.js';

export type ClassTeacherRow = Selectable<ClassTeacherAssignmentsTable>;
export type NewClassTeacher = Insertable<ClassTeacherAssignmentsTable>;
export type TeachingRow = Selectable<TeachingAssignmentsTable>;
export type NewTeaching = Insertable<TeachingAssignmentsTable>;

/** A teaching assignment with the name of the teacher. */
export interface TeachingView extends TeachingRow {
  staff_first_name: string;
  staff_last_name: string | null;
}

/** What ASG-01 asks for: the active assignments of one Institution's year. */
export interface TeachingFilter {
  institutionId: string;
  academicYearId: string;
  sectionId?: string;
  subjectId?: string;
  staffMemberId?: string;
}

/** Queries on the assignment tables; every one runs in the caller's transaction, under row-level security. */
@Injectable()
export class AssignmentRepository {
  /** The class-teacher rows that hold for a staff member, one for each year at most. */
  classTeacherOf(tx: Tx, staffMemberId: string): Promise<ClassTeacherRow[]> {
    return tx
      .selectFrom('class_teacher_assignments')
      .selectAll()
      .where('staff_member_id', '=', staffMemberId)
      .where('ended_at', 'is', null)
      .orderBy('created_at')
      .orderBy('id')
      .execute();
  }

  insertClassTeacher(tx: Tx, values: NewClassTeacher): Promise<ClassTeacherRow> {
    return tx
      .insertInto('class_teacher_assignments')
      .values(values)
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  async endClassTeacher(tx: Tx, id: string, by: string, now: Date): Promise<void> {
    await tx
      .updateTable('class_teacher_assignments')
      .set({ ended_at: now, ended_by: by })
      .where('id', '=', id)
      .where('ended_at', 'is', null)
      .execute();
  }

  /** Ends every assignment of the staff member, as a class teacher and as a teacher; returns how many ended. */
  async endAllOfStaff(
    tx: Tx,
    staffMemberId: string,
    by: string,
    now: Date,
  ): Promise<{ classTeacher: number; teaching: number }> {
    const ended = { ended_at: now, ended_by: by };
    const classTeacher = await tx
      .updateTable('class_teacher_assignments')
      .set(ended)
      .where('staff_member_id', '=', staffMemberId)
      .where('ended_at', 'is', null)
      .executeTakeFirst();
    const teaching = await tx
      .updateTable('teaching_assignments')
      .set(ended)
      .where('staff_member_id', '=', staffMemberId)
      .where('ended_at', 'is', null)
      .executeTakeFirst();
    return {
      classTeacher: Number(classTeacher.numUpdatedRows),
      teaching: Number(teaching.numUpdatedRows),
    };
  }

  insertTeaching(tx: Tx, values: NewTeaching): Promise<TeachingRow> {
    return tx
      .insertInto('teaching_assignments')
      .values(values)
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  /** The assignment, active or ended; locked when it is about to end. */
  findTeaching(tx: Tx, id: string, lock = false): Promise<TeachingRow | undefined> {
    const query = tx.selectFrom('teaching_assignments').selectAll().where('id', '=', id);
    return (lock ? query.forUpdate() : query).executeTakeFirst();
  }

  async endTeaching(tx: Tx, id: string, by: string, now: Date): Promise<void> {
    await tx
      .updateTable('teaching_assignments')
      .set({ ended_at: now, ended_by: by })
      .where('id', '=', id)
      .execute();
  }

  /** One page of the active assignments, by teacher name, with the total. */
  async pageTeaching(
    tx: Tx,
    filter: TeachingFilter,
    limit: number,
    offset: number,
  ): Promise<{ rows: TeachingView[]; total: number }> {
    const rows = await this.filtered(tx, filter)
      .select(['m.first_name as staff_first_name', 'm.last_name as staff_last_name'])
      .selectAll('a')
      .orderBy('m.first_name')
      .orderBy('m.last_name')
      .orderBy('a.created_at')
      .orderBy('a.id')
      .limit(limit)
      .offset(offset)
      .execute();
    const { total } = await this.filtered(tx, filter)
      .select((eb) => eb.fn.countAll<number>().as('total'))
      .executeTakeFirstOrThrow();
    return { rows, total: Number(total) };
  }

  private filtered(tx: Tx, filter: TeachingFilter) {
    let query = tx
      .selectFrom('teaching_assignments as a')
      .innerJoin('staff_members as m', 'm.id', 'a.staff_member_id')
      .where('a.institution_id', '=', filter.institutionId)
      .where('a.academic_year_id', '=', filter.academicYearId)
      .where('a.ended_at', 'is', null);
    if (filter.sectionId) query = query.where('a.section_id', '=', filter.sectionId);
    if (filter.subjectId) query = query.where('a.subject_id', '=', filter.subjectId);
    if (filter.staffMemberId) query = query.where('a.staff_member_id', '=', filter.staffMemberId);
    return query;
  }
}
