import { HttpStatus, Injectable } from '@nestjs/common';
import type { Principal } from '../../common/auth/access-token-verifier.js';
import { RoleCode } from '../../common/auth/roles.js';
import { ApiResult } from '../../common/http/api-result.js';
import { AppException } from '../../common/http/app-exception.js';
import { ErrorCode, FieldErrorCode, ResultCode } from '../../common/http/error-codes.js';
import { requireVersion } from '../../common/http/require-version.js';
import { fieldError } from '../../common/validation/field-error.js';
import { Clock } from '../../common/time/clock.js';
import { formatDay } from '../../common/time/format-day.js';
import { VersionedStatedReasonDto } from '../../common/validation/reason.dto.js';
import { AuditService } from '../../platform/audit/index.js';
import {
  DatabaseService,
  insertStamp,
  isDuplicateOn,
  updateStamp,
  type Tx,
} from '../../platform/database/index.js';
import { IdempotencyService } from '../../platform/idempotency/index.js';
import { PersonDirectory } from '../../platform/identity/index.js';
import { Notifications, type Notice } from '../../platform/notifications/index.js';
import { ScopeService, type InstitutionContext } from '../../platform/tenancy/index.js';
import { AcademicYearDirectory, SectionDirectory } from '../academic-setup/index.js';
import { HolidayCalendar } from '../events/index.js';
import { AttendanceStaff } from './attendance-staff.js';
import type {
  CorrectAttendanceDto,
  ListSessionsQueryDto,
  RosterQueryDto,
  SubmitAttendanceDto,
} from './attendance.dto.js';
import { AttendanceRepository, type SessionRow } from './attendance.repository.js';
import {
  existingSessionOf,
  sessionDetailResource,
  sessionResource,
  type AttendanceSessionDetailResource,
  type AttendanceSessionResource,
  type RosterResource,
} from './attendance.resource.js';
import {
  AttendanceStatus,
  applyCorrection,
  countMarks,
  dateRefusal,
  requireEachStudentOnce,
  requireMarkableDate,
} from './attendance.rules.js';
import { SectionRoster } from './section-roster.js';

/** The name the idempotency store keeps with a submission (API design 14.5). */
const SUBMIT_OPERATION = 'attendance.submit';

/** The screen and category of the alert to a parent (DDD 9.8): 1 Attendance. */
const ATTENDANCE_TARGET = 1;
const ATTENDANCE_CATEGORY = 1;
/** "Only for you" in the inbox. */
const ONLY_FOR_YOU = 1;

/**
 * ATT-01 to ATT-04 (API design 10.10, 10.11): taking a section's attendance once a day (PRD 7.7, decision 29). A
 * Society Owner and an Institution Admin mark any section of their Institutions; a teacher or staff member marks at
 * their home Institution only, and any section of it (D2). Only the students who were not Present are stored; the
 * rest were Present (DDD 13.2).
 */
@Injectable()
export class AttendanceService {
  constructor(
    private readonly database: DatabaseService,
    private readonly repository: AttendanceRepository,
    private readonly scope: ScopeService,
    private readonly years: AcademicYearDirectory,
    private readonly sections: SectionDirectory,
    private readonly holidays: HolidayCalendar,
    private readonly roster: SectionRoster,
    private readonly staff: AttendanceStaff,
    private readonly people: PersonDirectory,
    private readonly idempotency: IdempotencyService,
    private readonly notifications: Notifications,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  /**
   * ATT-01: the students of a section on a day, everyone Present until a session says otherwise, and whether the
   * caller may mark it now. A day that cannot be marked still loads, so the screen can show it.
   */
  async rosterOf(principal: Principal, query: RosterQueryDto): Promise<RosterResource> {
    const context = await this.sections.contextOf(principal, query.sectionId);
    return this.database.transaction(context.tenant, async (tx) => {
      const place = await this.sections.placeOf(tx, query.sectionId);
      if (!place) throw AppException.notFound();
      const section = (await this.sections.names(tx, [query.sectionId])).get(query.sectionId);
      if (!section) throw AppException.notFound();
      const yearId = await this.years.requireCurrentId(tx, context.institutionId);
      const year = await this.years.openYear(tx, yearId, context.institutionId);
      const existing = await this.repository.findActive(tx, query.sectionId, query.date);
      const holiday = await this.holidays.forClass(
        tx,
        context.institutionId,
        place.classId,
        query.date,
      );
      const marked = new Map(
        existing
          ? (await this.repository.exceptionsOf(tx, existing.id, query.date)).map((row) => [
              row.student_enrolment_id,
              row.attendance_status,
            ])
          : [],
      );
      const students = await this.roster.on(
        tx,
        query.sectionId,
        query.date,
        existing?.submitted_at,
      );
      const people = existing ? await this.people.describe([existing.submitted_by]) : new Map();
      const markable =
        place.active &&
        year !== undefined &&
        dateRefusal(query.date, this.clock.todayIst(), year) === undefined &&
        holiday === undefined &&
        existing === undefined &&
        (await this.mayMark(tx, principal, context.institutionId));
      return {
        section: {
          id: query.sectionId,
          displayName: section.displayName,
          classId: section.classId,
          className: section.className,
        },
        date: query.date,
        isHoliday: holiday !== undefined,
        holidayTitle: holiday?.title ?? null,
        canMark: markable,
        existingSession: existing ? existingSessionOf(existing, people) : null,
        students: students.map((student) => ({
          ...student,
          attendanceStatus: marked.get(student.studentEnrolmentId) ?? AttendanceStatus.Present,
        })),
      };
    });
  }

  /**
   * ATT-02: submits the attendance of a section for a day, once. 403 `NOT_ASSIGNED` for a teacher away from their home
   * Institution; 422 `DATE_IN_FUTURE`, `DATE_OUTSIDE_CURRENT_YEAR`, `DATE_IS_HOLIDAY`; 409 `ATTENDANCE_ALREADY_SUBMITTED`
   * (also when two submissions race), `ROSTER_CHANGED`; 422 `STUDENT_NOT_IN_SECTION`. One transaction: the session, its
   * marks, the audit and an alert job for each Absent student. The same key and body again gives the stored answer.
   */
  async submit(
    principal: Principal,
    key: string | string[] | undefined,
    body: SubmitAttendanceDto,
  ): Promise<ApiResult<AttendanceSessionResource>> {
    requireEachStudentOnce(body.exceptions);
    const context = await this.sections.contextOf(principal, body.sectionId);
    try {
      return await this.idempotency.run(
        {
          tenant: { ...context.tenant, personId: principal.personId },
          key,
          operation: SUBMIT_OPERATION,
          request: body,
        },
        async (tx) => {
          const submitted = await this.write(tx, principal, context, body);
          const people = await this.people.describe([principal.personId]);
          const names = await this.sections.names(tx, [body.sectionId]);
          const count = submitted.roster_count;
          return {
            result: ApiResult.created(
              sessionResource(submitted, names, people),
              ResultCode.ATTENDANCE_SUBMITTED,
              `Attendance submitted for ${count.toString()} ${count === 1 ? 'student' : 'students'}`,
            ),
            resourceId: submitted.id,
          };
        },
      );
    } catch (error) {
      if (!isDuplicateOn(error, 'uq_attendance_sessions_daily')) throw error;
      throw await this.alreadySubmitted(context, body);
    }
  }

  /** ATT-03: the sessions of a section, or of every section of an Institution, on a day. */
  async list(
    principal: Principal,
    query: ListSessionsQueryDto,
  ): Promise<ApiResult<AttendanceSessionResource[]>> {
    const context = await this.contextOf(principal, query);
    const { rows, names, people } = await this.database.transaction(context.tenant, async (tx) => {
      const found = await this.repository.list(tx, {
        date: query.date,
        sectionId: query.sectionId,
        institutionId: context.institutionId,
      });
      return {
        rows: found,
        names: await this.sections.names(tx, [...new Set(found.map((row) => row.section_id))]),
        people: await this.people.describe(found.map((row) => row.submitted_by)),
      };
    });
    return ApiResult.list(
      rows.map((row) => sessionResource(row, names, people)),
      null,
    );
  }

  /** ATT-04: one session with the students who were not Present. 404 for a session out of reach or voided. */
  async get(principal: Principal, sessionId: string): Promise<AttendanceSessionDetailResource> {
    const { tenant } = await this.scope.forPrincipal(principal);
    const found = await this.database.transaction(tenant, (tx) =>
      this.repository.find(tx, sessionId),
    );
    if (!found) throw AppException.notFound();
    const context = await this.scope.requireInstitution(principal, found.institution_id);
    return this.database.transaction(context.tenant, async (tx) => {
      const session = await this.repository.find(tx, sessionId);
      if (!session) throw AppException.notFound();
      const marks = await this.repository.exceptionsOf(tx, session.id, session.attendance_date);
      const enrolmentIds = marks.map((mark) => mark.student_enrolment_id);
      return sessionDetailResource(
        session,
        marks.map((mark) => ({
          studentEnrolmentId: mark.student_enrolment_id,
          attendanceStatus: mark.attendance_status,
        })),
        await this.roster.studentsOf(tx, enrolmentIds),
        await this.sections.names(tx, [session.section_id]),
        await this.people.describe([session.submitted_by]),
      );
    });
  }

  /**
   * ATT-05: changes the marks of a submitted session. 409 `VERSION_CONFLICT` first, then `SESSION_VOIDED`; 403
   * `NOT_ASSIGNED` for a teacher away from their home Institution and 403 `FORBIDDEN` for a teacher correcting a past
   * year, which only an Owner or an Admin may; 422 `STUDENT_NOT_IN_SECTION`. A request that changes nothing writes
   * nothing. One transaction: the marks, the counts, the audit of the correction, and an alert for each student who
   * is now Absent and was not.
   */
  async correct(
    principal: Principal,
    sessionId: string,
    body: CorrectAttendanceDto,
  ): Promise<AttendanceSessionResource> {
    requireEachStudentOnce(body.changes, 'changes');
    const context = await this.contextOfSession(principal, sessionId);
    return this.database.transaction(context.tenant, async (tx) => {
      const session = await this.lockedSession(tx, sessionId);
      requireVersion(session, body.version);
      this.requireActive(session);
      if (!(await this.mayMark(tx, principal, context.institutionId))) {
        throw AppException.forbidden(ErrorCode.NOT_ASSIGNED);
      }
      if (principal.roleCode === RoleCode.TeacherStaff) {
        const current = await this.years.requireCurrentId(tx, context.institutionId);
        if (current !== session.academic_year_id) throw AppException.forbidden();
      }
      const placed = new Set(
        (
          await this.roster.on(
            tx,
            session.section_id,
            session.attendance_date,
            session.submitted_at,
          )
        ).map((student) => student.studentEnrolmentId),
      );
      const strangers = body.changes.flatMap((change, index) =>
        placed.has(change.studentEnrolmentId)
          ? []
          : [
              fieldError(
                `changes[${index.toString()}].studentEnrolmentId`,
                ErrorCode.STUDENT_NOT_IN_SECTION,
              ),
            ],
      );
      if (strangers.length > 0) {
        throw new AppException(HttpStatus.UNPROCESSABLE_ENTITY, ErrorCode.STUDENT_NOT_IN_SECTION, {
          errors: strangers,
        });
      }
      const stored = await this.repository.exceptionsOf(tx, session.id, session.attendance_date);
      const outcome = applyCorrection(
        new Map(stored.map((row) => [row.student_enrolment_id, row.attendance_status])),
        body.changes,
      );
      const names = await this.sections.names(tx, [session.section_id]);
      const people = await this.people.describe([session.submitted_by]);
      if (outcome.changes.length === 0) return sessionResource(session, names, people);

      const correction = { at: this.clock.now(), by: principal.personId };
      const date = session.attendance_date;
      const added = outcome.changes.filter((change) => change.before === AttendanceStatus.Present);
      const removed = outcome.changes.filter((change) => change.after === AttendanceStatus.Present);
      const changed = outcome.changes.filter(
        (change) => !added.includes(change) && !removed.includes(change),
      );
      await this.repository.insertExceptions(
        tx,
        added.map((change) => ({
          attendance_session_id: session.id,
          student_enrolment_id: change.studentEnrolmentId,
          attendance_date: date,
          institution_id: session.institution_id,
          attendance_status: change.after,
          corrected_at: correction.at,
          corrected_by: correction.by,
        })),
      );
      for (const change of changed) {
        await this.repository.setStatus(
          tx,
          session.id,
          date,
          change.studentEnrolmentId,
          change.after,
          correction,
        );
      }
      await this.repository.removeExceptions(
        tx,
        session.id,
        date,
        removed.map((change) => change.studentEnrolmentId),
      );
      const counts = countMarks(outcome.marks);
      const updated = await this.repository.update(tx, session.id, {
        absent_count: counts.absent,
        late_count: counts.late,
        half_day_count: counts.halfDay,
        leave_count: counts.leave,
        last_corrected_at: correction.at,
        last_corrected_by: correction.by,
        ...updateStamp(principal.personId),
      });
      await this.audit.record(tx, {
        action: 'attendance.corrected',
        societyId: updated.society_id,
        institutionId: updated.institution_id,
        entityType: 'attendance_session',
        entityId: updated.id,
        before: {
          marks: Object.fromEntries(outcome.changes.map((c) => [c.studentEnrolmentId, c.before])),
        },
        after: {
          marks: Object.fromEntries(outcome.changes.map((c) => [c.studentEnrolmentId, c.after])),
        },
      });
      await this.alertParents(
        tx,
        updated,
        principal,
        outcome.changes
          .filter((change) => change.after === AttendanceStatus.Absent)
          .map((change) => change.studentEnrolmentId),
        // Dated by the submission, as the first alert is: the inbox keys a notice by its source key and time, so a
        // child marked Absent again is told once (API design 10.12).
        updated.submitted_at,
      );
      return sessionResource(updated, names, people);
    });
  }

  /**
   * ATT-06: voids a session submitted by mistake, which frees the day for a new submission. Owners and Admins only
   * (the route). 409 `VERSION_CONFLICT` first, then `SESSION_VOIDED` for one already void. Its marks stay, ignored with
   * it; the reason is kept in the audit entry. Nothing is told to the parents.
   */
  async voidSession(
    principal: Principal,
    sessionId: string,
    body: VersionedStatedReasonDto,
  ): Promise<{ id: string; status: 0 }> {
    const context = await this.contextOfSession(principal, sessionId);
    await this.database.transaction(context.tenant, async (tx) => {
      const session = await this.lockedSession(tx, sessionId);
      requireVersion(session, body.version);
      this.requireActive(session);
      const updated = await this.repository.update(tx, session.id, {
        status: 0,
        ...updateStamp(principal.personId),
      });
      await this.audit.record(tx, {
        action: 'attendance.voided',
        societyId: updated.society_id,
        institutionId: updated.institution_id,
        entityType: 'attendance_session',
        entityId: updated.id,
        reason: body.reason,
        before: { status: session.status },
        after: { status: updated.status },
      });
    });
    return { id: sessionId, status: 0 };
  }

  /** The Institution a session is in, when the caller reaches it; 404 for a session out of reach, voided or not. */
  private async contextOfSession(
    principal: Principal,
    sessionId: string,
  ): Promise<InstitutionContext> {
    const { tenant } = await this.scope.forPrincipal(principal);
    const found = await this.database.transaction(tenant, (tx) =>
      this.repository.findAny(tx, sessionId),
    );
    if (!found) throw AppException.notFound();
    return this.scope.requireInstitution(principal, found.institution_id);
  }

  private async lockedSession(tx: Tx, sessionId: string): Promise<SessionRow> {
    const session = await this.repository.lockAny(tx, sessionId);
    if (!session) throw AppException.notFound();
    return session;
  }

  private requireActive(session: SessionRow): void {
    if (session.status !== 1) throw AppException.conflict(ErrorCode.SESSION_VOIDED);
  }

  /** The writes of a submission, in the idempotency transaction. */
  private async write(
    tx: Tx,
    principal: Principal,
    context: InstitutionContext,
    body: SubmitAttendanceDto,
  ): Promise<SessionRow> {
    const place = await this.sections.placeOf(tx, body.sectionId);
    if (!place) throw AppException.notFound();
    if (!place.active) throw AppException.referenceInactive('sectionId');
    if (!(await this.mayMark(tx, principal, context.institutionId))) {
      throw AppException.forbidden(ErrorCode.NOT_ASSIGNED);
    }
    const yearId = await this.years.requireCurrentId(tx, context.institutionId);
    const year = await this.years.openYear(tx, yearId, context.institutionId);
    requireMarkableDate(body.attendanceDate, this.clock.todayIst(), year!);
    if (
      await this.holidays.forClass(tx, context.institutionId, place.classId, body.attendanceDate)
    ) {
      throw new AppException(HttpStatus.UNPROCESSABLE_ENTITY, ErrorCode.DATE_IS_HOLIDAY);
    }
    // A move out of the section (STU-08) waits for this register, or this waits for the move (QA B6 D1).
    await this.repository.lockRegister(tx, body.sectionId);
    const existing = await this.repository.findActive(tx, body.sectionId, body.attendanceDate);
    if (existing) {
      throw new AppException(HttpStatus.CONFLICT, ErrorCode.ATTENDANCE_ALREADY_SUBMITTED, {
        details: { sessionId: existing.id },
      });
    }
    const students = await this.roster.on(tx, body.sectionId, body.attendanceDate);
    if (students.length !== body.rosterCount) {
      throw new AppException(HttpStatus.CONFLICT, ErrorCode.ROSTER_CHANGED, {
        details: { rosterCount: students.length },
      });
    }
    const placed = new Set(students.map((student) => student.studentEnrolmentId));
    const strangers = body.exceptions.flatMap((mark, index) =>
      placed.has(mark.studentEnrolmentId)
        ? []
        : [
            fieldError(
              `exceptions[${index.toString()}].studentEnrolmentId`,
              ErrorCode.STUDENT_NOT_IN_SECTION,
            ),
          ],
    );
    if (strangers.length > 0) {
      throw new AppException(HttpStatus.UNPROCESSABLE_ENTITY, ErrorCode.STUDENT_NOT_IN_SECTION, {
        errors: strangers,
      });
    }

    const counts = countMarks(body.exceptions);
    const taker = await this.staff.ownRecord(tx, principal.personId);
    const session = await this.repository.insert(tx, {
      society_id: context.societyId,
      institution_id: context.institutionId,
      academic_year_id: yearId,
      section_id: body.sectionId,
      attendance_date: body.attendanceDate,
      taken_by_staff_member_id:
        taker?.homeInstitutionId === context.institutionId ? taker.staffMemberId : null,
      roster_count: students.length,
      absent_count: counts.absent,
      late_count: counts.late,
      half_day_count: counts.halfDay,
      leave_count: counts.leave,
      submitted_by: principal.personId,
      ...insertStamp(principal.personId),
    });
    await this.repository.insertExceptions(
      tx,
      body.exceptions.map((mark) => ({
        attendance_session_id: session.id,
        student_enrolment_id: mark.studentEnrolmentId,
        attendance_date: session.attendance_date,
        institution_id: session.institution_id,
        attendance_status: mark.attendanceStatus,
      })),
    );
    await this.audit.record(tx, {
      action: 'attendance.submitted',
      societyId: session.society_id,
      institutionId: session.institution_id,
      entityType: 'attendance_session',
      entityId: session.id,
      after: {
        section_id: session.section_id,
        attendance_date: session.attendance_date,
        roster_count: session.roster_count,
        absent_count: session.absent_count,
        late_count: session.late_count,
        half_day_count: session.half_day_count,
        leave_count: session.leave_count,
      },
    });
    await this.alertParents(
      tx,
      session,
      principal,
      body.exceptions
        .filter((mark) => mark.attendanceStatus === AttendanceStatus.Absent)
        .map((mark) => mark.studentEnrolmentId),
      session.submitted_at,
    );
    return session;
  }

  /**
   * One alert for each Absent student, to the guardians who have a login (PRD 10). The key is the session and the
   * student, so a job that runs twice tells no one twice. The text names the child and the day and no more (SDD 18).
   */
  private async alertParents(
    tx: Tx,
    session: SessionRow,
    principal: Principal,
    absentEnrolmentIds: readonly string[],
    occurredAt: Date,
  ): Promise<void> {
    if (absentEnrolmentIds.length === 0) return;
    const [students, guardians] = await Promise.all([
      this.roster.studentsOf(tx, absentEnrolmentIds),
      this.roster.guardiansOf(tx, absentEnrolmentIds),
    ]);
    for (const enrolmentId of absentEnrolmentIds) {
      const student = students.get(enrolmentId);
      const receivers = guardians.get(enrolmentId) ?? [];
      if (!student) continue;
      const notice: Notice = {
        societyId: session.society_id,
        institutionId: session.institution_id,
        sourceKey: `absent:${session.id}:${enrolmentId}`,
        occurredAt,
        category: ATTENDANCE_CATEGORY,
        tab: ONLY_FOR_YOU,
        title: 'Marked absent',
        body: `${student.firstName} was marked absent on ${formatDay(session.attendance_date)}.`,
        target: { type: ATTENDANCE_TARGET, id: session.id },
        receivers: receivers.map((userId) => ({ userId, studentId: student.studentId })),
      };
      await this.notifications.notify(tx, notice, principal.personId);
    }
  }

  /** Whether the caller may mark at this Institution: the Owner and the Admin may; staff only at their home one. */
  private async mayMark(tx: Tx, principal: Principal, institutionId: string): Promise<boolean> {
    if (principal.roleCode !== RoleCode.TeacherStaff) return true;
    const own = await this.staff.ownRecord(tx, principal.personId);
    return own?.homeInstitutionId === institutionId;
  }

  /** The 409 of two submissions that raced, with the session the other one made. */
  private async alreadySubmitted(
    context: InstitutionContext,
    body: SubmitAttendanceDto,
  ): Promise<AppException> {
    const existing = await this.database.transaction(context.tenant, (tx) =>
      this.repository.findActive(tx, body.sectionId, body.attendanceDate),
    );
    return new AppException(HttpStatus.CONFLICT, ErrorCode.ATTENDANCE_ALREADY_SUBMITTED, {
      details: existing ? { sessionId: existing.id } : undefined,
    });
  }

  /** ATT-03: the Institution of one section, or the one named (400 `REQUIRED` for neither). */
  private async contextOf(
    principal: Principal,
    query: ListSessionsQueryDto,
  ): Promise<InstitutionContext> {
    if (query.sectionId !== undefined) {
      if (query.institutionId !== undefined) {
        throw AppException.validation([
          fieldError('institutionId', FieldErrorCode.FIELD_NOT_ALLOWED),
        ]);
      }
      return this.sections.contextOf(principal, query.sectionId);
    }
    if (query.institutionId === undefined) {
      throw AppException.validation([fieldError('institutionId', FieldErrorCode.REQUIRED)]);
    }
    return this.scope.requireInstitution(principal, query.institutionId);
  }
}
