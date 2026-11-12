import { HttpStatus, Injectable } from '@nestjs/common';
import type { Principal } from '../../common/auth/access-token-verifier.js';
import { RoleCode } from '../../common/auth/roles.js';
import { ApiResult } from '../../common/http/api-result.js';
import { AppException } from '../../common/http/app-exception.js';
import { changedColumns } from '../../common/http/changed-columns.js';
import { ErrorCode, ResultCode } from '../../common/http/error-codes.js';
import { requireVersion } from '../../common/http/require-version.js';
import { Clock } from '../../common/time/clock.js';
import { AuditService } from '../../platform/audit/index.js';
import {
  DatabaseService,
  insertStamp,
  isDuplicateOn,
  updateStamp,
  type Tx,
} from '../../platform/database/index.js';
import {
  AccountDirectory,
  maskEmail,
  type GuardianEmailChange,
  type LinkedPerson,
} from '../../platform/identity/index.js';
import { InstitutionDirectory } from '../../platform/tenancy/index.js';
import { GuardianContext } from './guardian-context.js';
import type { UpdateGuardianDto } from './guardian.dto.js';
import { GuardianRepository, type GuardianChanges } from './guardian.repository.js';
import { StudentContext } from './student-context.js';
import { MAX_GUARDIANS, type GuardianDto } from './student.dto.js';
import { StudentRepository, type GuardianRow, type StudentRow } from './student.repository.js';
import { guardianResource, type GuardianResource } from './student.resource.js';
import { guardianAuditView } from './student.rules.js';

/** The unique index that allows a person to be one active guardian of a child. */
const ONE_LINK_PER_CHILD = 'uq_student_guardians_student_user';

/** What an edit of the login did, for the audit entry and the mail after the commit. */
type LoginChange =
  | { outcome: 'linked'; person: LinkedPerson }
  | { outcome: 'unlinked'; previousEmail: string | null; sessionsEnded: number }
  | { outcome: 'edited' | 'moved'; change: Exclude<GuardianEmailChange, { kind: 'unchanged' }> }
  | { outcome: 'synced'; person: LinkedPerson };

/**
 * GDN-01 to GDN-04 (API design 9.6, 6.6): the guardians of a student, the people who may sign in as the child's
 * Student / Parent. A student keeps one to five, exactly one of them primary. Every change takes the student row first
 * (the one lock order of DDD 13.3), then the guardian, then the account.
 */
@Injectable()
export class GuardianService {
  constructor(
    private readonly database: DatabaseService,
    private readonly students: StudentRepository,
    private readonly guardians: GuardianRepository,
    private readonly studentContext: StudentContext,
    private readonly context: GuardianContext,
    private readonly accounts: AccountDirectory,
    private readonly institutions: InstitutionDirectory,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  /** GDN-01: the active guardians, the primary first; every one, as a student has five at most. 404 outside the caller's reach. */
  async list(principal: Principal, studentId: string): Promise<GuardianResource[]> {
    const context = await this.studentContext.of(principal, studentId);
    const rows = await this.database.transaction(context.tenant, (tx) =>
      this.students.guardians(tx, studentId),
    );
    return rows.map(guardianResource);
  }

  /**
   * GDN-02: adds a guardian to an active student. An email links the person it belongs to or makes a Pending account,
   * and the welcome mail goes after the commit. `isPrimary` makes the new guardian the primary and the previous one an
   * ordinary guardian. 422 `GUARDIAN_LIMIT_REACHED` for a sixth; 409 `ALREADY_GUARDIAN` when the person is already a
   * guardian of this student; 409 `ROLE_CONFLICT` (a Super Admin) and `ACCOUNT_BLOCKED` for an email that cannot be
   * linked.
   */
  async add(
    principal: Principal,
    studentId: string,
    body: GuardianDto,
  ): Promise<ApiResult<GuardianResource>> {
    const context = await this.studentContext.of(principal, studentId);
    const created = await this.database
      .transaction(context.tenant, async (tx) => {
        const student = await this.studentContext.lockedActive(tx, studentId);
        if ((await this.students.guardians(tx, studentId)).length >= MAX_GUARDIANS) {
          throw AppException.businessRule(ErrorCode.GUARDIAN_LIMIT_REACHED);
        }
        const person =
          body.email == null
            ? null
            : await this.accounts.linkGuardian(
                tx,
                {
                  email: body.email,
                  firstName: body.firstName,
                  lastName: body.lastName ?? undefined,
                },
                principal.personId,
              );
        if (person && (await this.guardians.isLinked(tx, studentId, person.id))) {
          throw AppException.conflict(ErrorCode.ALREADY_GUARDIAN);
        }
        if (body.isPrimary) await this.handOverPrimary(tx, studentId, principal.personId);
        const [row] = await this.students.insertGuardians(tx, [
          {
            society_id: student.society_id,
            institution_id: student.institution_id,
            ...insertStamp(principal.personId),
            student_id: studentId,
            user_id: person?.id ?? null,
            first_name: body.firstName,
            last_name: body.lastName ?? null,
            relation: body.relation,
            country_code: body.phone.countryCode,
            phone_number: body.phone.number,
            alternate_phone: body.alternatePhone ?? null,
            email: person?.email ?? null,
            occupation: body.occupation ?? null,
            is_primary: body.isPrimary,
            is_emergency_contact: body.isEmergencyContact,
          },
        ]);
        await this.audit.record(tx, {
          action: 'guardian.added',
          institutionId: student.institution_id,
          entityType: 'student_guardian',
          entityId: row!.id,
          after: { studentId, ...guardianAuditView(row!) },
        });
        return { row: row!, person, societyName: await this.societyName(tx, student) };
      })
      .catch((error: unknown) => {
        throw translate(error);
      });
    if (created.person) {
      this.accounts.welcomeAs(created.person, RoleCode.StudentParent, created.societyName);
    }
    return new ApiResult(guardianResource(created.row), {
      status: HttpStatus.CREATED,
      code: ResultCode.CREATED,
    });
  }

  /**
   * GDN-03: `version` is checked first; a request that changes nothing writes nothing. The email follows 6.6: one that
   * belongs to no person changes the person's own email when this link is all they hold, else makes a new person the
   * link moves to; one that belongs to a person moves the link to them; a guardian without a login is linked by an email
   * and `null` takes the login away. `isPrimary: true` hands the place over; `false` for the primary is 422
   * `PRIMARY_GUARDIAN_REQUIRED`. 404 for a removed guardian or one of a deactivated student; 409 `ALREADY_GUARDIAN`.
   */
  async update(
    principal: Principal,
    id: string,
    body: UpdateGuardianDto,
  ): Promise<GuardianResource> {
    const { context, guardian: seen } = await this.context.of(principal, id);
    const now = this.clock.now();
    const done = await this.database
      .transaction(context.tenant, async (tx) => {
        const student = await this.studentContext.lockedActive(tx, seen.student_id);
        const current = await this.locked(tx, id);
        requireVersion(current, body.version);
        if (body.isPrimary === false && current.is_primary) {
          throw AppException.businessRule(ErrorCode.PRIMARY_GUARDIAN_REQUIRED);
        }
        const login = await this.changeLogin(tx, principal, current, body, now);
        const takesPrimary = body.isPrimary === true && !current.is_primary;
        const changes: GuardianChanges = {
          ...(changedColumns(current, {
            ...(body.firstName === undefined ? {} : { first_name: body.firstName }),
            last_name: body.lastName,
            relation: body.relation,
            country_code: body.phone?.countryCode,
            phone_number: body.phone?.number,
            alternate_phone: body.alternatePhone,
            occupation: body.occupation,
            is_emergency_contact: body.isEmergencyContact,
          }) as GuardianChanges),
          ...(takesPrimary ? { is_primary: true } : {}),
        };
        const loginColumns = loginColumnsOf(login);
        if (Object.keys(changes).length === 0 && login === undefined) {
          return { row: current, login, societyName: null };
        }
        if (takesPrimary) await this.handOverPrimary(tx, current.student_id, principal.personId);
        const row = await this.guardians.update(tx, id, {
          ...changes,
          ...loginColumns,
          ...updateStamp(principal.personId),
        });
        if (Object.keys(changes).length > 0) {
          await this.audit.record(tx, {
            action: 'guardian.updated',
            institutionId: row.institution_id,
            entityType: 'student_guardian',
            entityId: id,
            before: guardianAuditView(current),
            after: guardianAuditView(row),
          });
        }
        if (login) await this.auditLogin(tx, current, row, login);
        return { row, login, societyName: await this.societyName(tx, student) };
      })
      .catch((error: unknown) => {
        throw translate(error);
      });
    this.announce(done.login, done.societyName);
    return guardianResource(done.row);
  }

  /**
   * GDN-04: removes a guardian (`status` 0; the row stays). The primary cannot go, and a student keeps at least one
   * guardian: 422 `PRIMARY_GUARDIAN_REQUIRED`, 422 `LAST_GUARDIAN`. The person loses the child at once, and their
   * parent sessions end when this was their last child; their account and their other children are untouched. 404 for one
   * already removed or of a deactivated student.
   */
  async remove(principal: Principal, id: string): Promise<{ id: string; status: 0 }> {
    const { context, guardian: seen } = await this.context.of(principal, id);
    const now = this.clock.now();
    const done = await this.database.transaction(context.tenant, async (tx) => {
      await this.studentContext.lockedActive(tx, seen.student_id);
      const current = await this.locked(tx, id);
      if ((await this.students.guardians(tx, current.student_id)).length <= 1) {
        throw AppException.businessRule(ErrorCode.LAST_GUARDIAN);
      }
      if (current.is_primary) throw AppException.businessRule(ErrorCode.PRIMARY_GUARDIAN_REQUIRED);
      const row = await this.guardians.update(tx, id, {
        status: 0,
        ...updateStamp(principal.personId),
      });
      const sessionsEnded =
        current.user_id === null
          ? 0
          : await this.accounts.endParentSessionsIfLast(tx, current.user_id, now);
      await this.audit.record(tx, {
        action: 'guardian.removed',
        institutionId: row.institution_id,
        entityType: 'student_guardian',
        entityId: id,
        before: { studentId: current.student_id, ...guardianAuditView(current) },
        after: { ...guardianAuditView(row), sessionsEnded },
      });
      return current.user_id === null ? null : current.email;
    });
    if (done) this.accounts.announceGuardianRemoved(done);
    return { id, status: 0 };
  }

  /** The guardian, locked for the change, after its student; 404 when it is gone. */
  private async locked(tx: Tx, id: string): Promise<GuardianRow> {
    const current = await this.guardians.find(tx, id, true);
    if (!current || current.status === 0) throw AppException.notFound();
    return current;
  }

  /** The place of primary goes to another guardian: the one who holds it now becomes an ordinary guardian. */
  private async handOverPrimary(tx: Tx, studentId: string, by: string): Promise<void> {
    const held = await this.guardians.primaryOf(tx, studentId);
    if (!held) return;
    const row = await this.guardians.update(tx, held.id, {
      is_primary: false,
      ...updateStamp(by),
    });
    await this.audit.record(tx, {
      action: 'guardian.updated',
      institutionId: row.institution_id,
      entityType: 'student_guardian',
      entityId: row.id,
      before: guardianAuditView(held),
      after: guardianAuditView(row),
    });
  }

  /**
   * What an `email` in the body does to the login (API design 6.6); nothing when it is left out or the same. The new
   * link may not be a person who already is a guardian of this student (409 `ALREADY_GUARDIAN`).
   */
  private async changeLogin(
    tx: Tx,
    principal: Principal,
    current: GuardianRow,
    body: UpdateGuardianDto,
    now: Date,
  ): Promise<LoginChange | undefined> {
    if (body.email === undefined) return undefined;
    const email = body.email?.toLowerCase() ?? null;
    if (email === current.email) return undefined;
    if (email === null) {
      const sessionsEnded =
        current.user_id === null
          ? 0
          : await this.accounts.endParentSessionsIfLast(tx, current.user_id, now);
      return { outcome: 'unlinked', previousEmail: current.email, sessionsEnded };
    }
    const names = {
      firstName: body.firstName ?? current.first_name,
      lastName: body.lastName === undefined ? current.last_name : body.lastName,
    };
    const vet = async (personId: string) => {
      if (await this.guardians.isLinked(tx, current.student_id, personId, current.id)) {
        throw AppException.conflict(ErrorCode.ALREADY_GUARDIAN);
      }
    };
    if (current.user_id === null) {
      const person = await this.accounts.linkGuardian(
        tx,
        { email, firstName: names.firstName, lastName: names.lastName ?? undefined },
        principal.personId,
      );
      await vet(person.id);
      return { outcome: 'linked', person };
    }
    const change = await this.accounts.changeGuardianEmail(tx, {
      userId: current.user_id,
      societyId: current.society_id,
      email,
      names,
      by: principal.personId,
      now,
      vet,
    });
    return change.kind === 'unchanged'
      ? { outcome: 'synced', person: change.person }
      : { outcome: change.kind, change };
  }

  private async auditLogin(
    tx: Tx,
    before: GuardianRow,
    after: GuardianRow,
    login: LoginChange,
  ): Promise<void> {
    await this.audit.record(tx, {
      action: 'guardian.email_changed',
      institutionId: after.institution_id,
      entityType: 'student_guardian',
      entityId: after.id,
      before: {
        email: before.email === null ? null : maskEmail(before.email),
        personId: before.user_id,
      },
      after: {
        email: after.email === null ? null : maskEmail(after.email),
        personId: after.user_id,
        // The masks of two addresses can read alike, and the log keeps only what changed: say it was another address.
        emailChanged: before.email !== after.email,
        outcome: login.outcome,
        ...('sessionsEnded' in login
          ? { sessionsEnded: login.sessionsEnded }
          : 'change' in login
            ? { sessionsEnded: login.change.sessionsEnded }
            : {}),
      },
    });
  }

  /** The mails after the commit: the welcome of a person linked, the notices of an email changed or taken away. */
  private announce(login: LoginChange | undefined, societyName: string | null): void {
    if (!login || login.outcome === 'synced') return;
    if (login.outcome === 'linked') {
      this.accounts.welcomeAs(login.person, RoleCode.StudentParent, societyName);
    } else if (login.outcome === 'unlinked') {
      if (login.previousEmail) this.accounts.announceGuardianRemoved(login.previousEmail);
    } else {
      this.accounts.announceGuardianEmail(login.change, societyName);
    }
  }

  private async societyName(tx: Tx, student: StudentRow): Promise<string | null> {
    const names = await this.institutions.names(tx, [student.institution_id]);
    return names.get(student.institution_id)?.societyName ?? null;
  }
}

/** The columns an edit of the login sets on the guardian row. */
function loginColumnsOf(login: LoginChange | undefined): GuardianChanges {
  if (!login) return {};
  if (login.outcome === 'linked' || login.outcome === 'synced') {
    return { user_id: login.person.id, email: login.person.email };
  }
  if (login.outcome === 'unlinked') return { user_id: null, email: null };
  return { user_id: login.change.person.id, email: login.change.person.email };
}

/** A unique violation on the person, in the words of the API. */
function translate(error: unknown): unknown {
  return isDuplicateOn(error, ONE_LINK_PER_CHILD)
    ? AppException.conflict(ErrorCode.ALREADY_GUARDIAN)
    : error;
}
