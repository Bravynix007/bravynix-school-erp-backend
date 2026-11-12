import { HttpStatus, Injectable } from '@nestjs/common';
import type { Principal } from '../../common/auth/access-token-verifier.js';
import { ApiResult, warnings } from '../../common/http/api-result.js';
import { AppException } from '../../common/http/app-exception.js';
import { ErrorCode, ResultCode } from '../../common/http/error-codes.js';
import { Clock } from '../../common/time/clock.js';
import { AuditService } from '../../platform/audit/index.js';
import { DatabaseService, isDuplicateOn, type Tx } from '../../platform/database/index.js';
import {
  IdentityNumbers,
  maskAadhaar,
  type ProtectedAadhaar,
} from '../../platform/identity-numbers/index.js';
import type { RevealIdentityDto } from './identity.dto.js';
import { maskedAadhaar, type RevealResource } from './identity.resource.js';
import { sameNumber } from './identity.rules.js';
import type { StudentIdentityDto } from './student-identity.dto.js';
import {
  StudentIdentityRepository,
  type StudentIdentityRow,
  type StudentIdentityValues,
} from './student-identity.repository.js';
import {
  studentIdentityResource,
  type StudentIdentityResource,
} from './student-identity.resource.js';
import { StudentContext } from './student-context.js';
import { StudentRepository, type StudentRow } from './student.repository.js';

/** The unique index that keeps one record per number in an Institution (DDD 9.6). */
const ONE_RECORD_PER_NUMBER = 'uq_student_identities_institution_aadhaar';

/** The number is held by a student of another Institution of the Society: a transfer, which warns and never stops. */
export const AADHAAR_EXISTS_IN_SOCIETY = 'AADHAAR_EXISTS_IN_SOCIETY';

/** What a write of a student's identity leaves behind, and whether it should warn. */
export interface IdentityWritten {
  row: StudentIdentityRow | undefined;
  /** The Aadhaar number sent is also held by a student of another Institution of the Society. */
  elsewhere: boolean;
}

/**
 * STU-10 and STU-11 (API design 6.8, 10.9), and the `identity` of STU-02: a student's Aadhaar and birth certificate
 * numbers. They are written, never read back whole: every answer shows the Aadhaar number masked, and the whole number
 * comes only from STU-11, which is limited and audited.
 */
@Injectable()
export class StudentIdentityService {
  constructor(
    private readonly database: DatabaseService,
    private readonly students: StudentRepository,
    private readonly context: StudentContext,
    private readonly identities: StudentIdentityRepository,
    private readonly numbers: IdentityNumbers,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  /**
   * The Aadhaar number of `body` sealed for the student `studentId`, `null` to clear it, `undefined` to leave it. 422
   * `INVALID_AADHAAR` for a number that is not one, before anything is written.
   */
  seal(
    studentId: string,
    body: StudentIdentityDto | undefined,
  ): ProtectedAadhaar | null | undefined {
    const number = body?.aadhaarNumber;
    if (number === undefined || number === null) return number;
    return this.numbers.protect(number, { table: 'student_identities', rowId: studentId });
  }

  /**
   * STU-10: sets the numbers sent, `null` clears one, a number left out stays. 422 `INVALID_AADHAAR`; 409
   * `AADHAAR_DUPLICATE_IN_INSTITUTION` when another active student of the Institution holds the Aadhaar number,
   * without naming them (a deactivated student gives their number up to the new claim, audited as
   * `identity.released`). The same numbers again write nothing. A student of another Institution of the Society who
   * holds the number is the warning `AADHAAR_EXISTS_IN_SOCIETY` (a transfer), not an error. 404 for a deactivated
   * student.
   */
  async set(
    principal: Principal,
    id: string,
    body: StudentIdentityDto,
  ): Promise<ApiResult<StudentIdentityResource>> {
    const context = await this.context.of(principal, id);
    const claim = this.seal(id, body);
    const written = await this.database.transaction(context.tenant, async (tx) => {
      const student = await this.context.lockedActive(tx, id);
      return this.write(tx, student, claim, body.birthCertificateNumber, principal.personId);
    });
    return new ApiResult(studentIdentityResource(written.row), {
      status: HttpStatus.OK,
      code: ResultCode.OK,
      meta: written.elsewhere ? warnings(AADHAAR_EXISTS_IN_SOCIETY) : null,
    });
  }

  /**
   * Writes the numbers of `student` inside the caller's transaction: the part of STU-02 and STU-10 they share. An
   * Aadhaar number held by an active student of the Institution is refused, one held by a deactivated student is
   * taken over; what already stands is left alone, so a repeated request writes nothing. Audited as
   * `identity.updated` or `identity.cleared` with the masked number, never the number.
   */
  async write(
    tx: Tx,
    student: StudentRow,
    aadhaar: ProtectedAadhaar | null | undefined,
    birthCertificateNumber: string | null | undefined,
    by: string,
  ): Promise<IdentityWritten> {
    const before = await this.identities.find(tx, student.id);
    const elsewhere = aadhaar
      ? await this.identities.heldElsewhere(tx, student.institution_id, aadhaar.hmac)
      : false;
    const certificate = birthCertificateNumber?.trim() ?? birthCertificateNumber;
    const values: StudentIdentityValues = {};
    if (aadhaar !== undefined && !sameNumber(before, aadhaar)) values.aadhaar = aadhaar;
    if (certificate !== undefined && certificate !== (before?.birth_certificate_number ?? null)) {
      values.birthCertificateNumber = certificate;
    }
    if (Object.keys(values).length === 0) return { row: before, elsewhere };
    try {
      if (values.aadhaar) await this.releaseHolder(tx, student, values.aadhaar, by);
      await this.identities.put(
        tx,
        {
          studentId: student.id,
          societyId: student.society_id,
          institutionId: student.institution_id,
          by,
        },
        values,
      );
    } catch (error: unknown) {
      if (isDuplicateOn(error, ONE_RECORD_PER_NUMBER)) {
        throw AppException.conflict(ErrorCode.AADHAAR_DUPLICATE_IN_INSTITUTION);
      }
      throw error;
    }
    const row = await this.identities.find(tx, student.id);
    await this.audit.record(tx, {
      action:
        row?.aadhaar_last4 || row?.birth_certificate_number
          ? 'identity.updated'
          : 'identity.cleared',
      institutionId: student.institution_id,
      entityType: 'student_identities',
      entityId: student.id,
      before: auditView(before),
      after: auditView(row),
    });
    return { row, elsewhere };
  }

  /**
   * An active student of the Institution who holds the number refuses it (409); a deactivated one gives it up,
   * audited on that record.
   */
  private async releaseHolder(
    tx: Tx,
    claimant: StudentRow,
    claim: ProtectedAadhaar,
    by: string,
  ): Promise<void> {
    const holder = await this.identities.holderOf(
      tx,
      claimant.institution_id,
      claim.hmac,
      claimant.id,
    );
    if (!holder) return;
    if (holder.status === 1)
      throw AppException.conflict(ErrorCode.AADHAAR_DUPLICATE_IN_INSTITUTION);
    await this.identities.put(
      tx,
      {
        studentId: holder.studentId,
        societyId: claimant.society_id,
        institutionId: claimant.institution_id,
        by,
      },
      { aadhaar: null },
    );
    await this.audit.record(tx, {
      action: 'identity.released',
      institutionId: claimant.institution_id,
      entityType: 'student_identities',
      entityId: holder.studentId,
      before: { aadhaarMasked: maskAadhaar(claim.last4) },
      after: { aadhaarMasked: null, takenBy: claimant.id },
    });
  }

  /**
   * STU-11: the whole Aadhaar number, for an admin who gives a reason (10 to 500 characters). 404 `NOT_SET` when the
   * record holds no number; 429 `REVEAL_LIMIT` after ten reveals by this admin in an IST day. The entry
   * `identity.reveal` is written before the number is returned and holds the reason, never the number. Allowed for a
   * deactivated student, whose number is still on file.
   */
  async reveal(principal: Principal, id: string, body: RevealIdentityDto): Promise<RevealResource> {
    const context = await this.context.of(principal, id);
    const value = await this.database.transaction(context.tenant, async (tx) => {
      const student = await this.students.find(tx, id);
      if (!student) throw AppException.notFound();
      const stored = await this.identities.find(tx, id);
      if (!stored?.aadhaar_ciphertext || stored.aadhaar_key_version === null) {
        throw new AppException(HttpStatus.NOT_FOUND, ErrorCode.NOT_SET);
      }
      return this.numbers.reveal(tx, {
        slot: { table: 'student_identities', rowId: id },
        stored: { ciphertext: stored.aadhaar_ciphertext, keyVersion: stored.aadhaar_key_version },
        institutionId: student.institution_id,
        reason: body.reason,
      });
    });
    return { field: body.field, value, revealedAt: this.clock.now().toISOString() };
  }
}

/** What an audit entry keeps of a student's identity: the masked number and the certificate, never the number. */
const auditView = (row: StudentIdentityRow | undefined) => ({
  aadhaarMasked: maskedAadhaar(row),
  birthCertificateNumber: row?.birth_certificate_number ?? null,
});
