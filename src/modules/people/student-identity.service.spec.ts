import { randomBytes } from 'node:crypto';
import type { Principal } from '../../common/auth/access-token-verifier.js';
import { AppException } from '../../common/http/app-exception.js';
import { FixedClock } from '../../common/time/clock.js';
import type { AuditService } from '../../platform/audit/index.js';
import { SecretBox } from '../../platform/crypto/index.js';
import type { DatabaseService, Tx } from '../../platform/database/index.js';
import { IdentityNumbers } from '../../platform/identity-numbers/index.js';
import type { ScopeService } from '../../platform/tenancy/index.js';
import { StudentContext } from './student-context.js';
import type {
  StudentIdentityRepository,
  StudentIdentityRow,
} from './student-identity.repository.js';
import { StudentIdentityService } from './student-identity.service.js';
import type { StudentRepository, StudentRow } from './student.repository.js';

const NUMBER = '2345 6789 0124';
const admin = { personId: 'admin-1', roleCode: 3, societyId: 'society-1' } as unknown as Principal;

const numbers = new IdentityNumbers(
  new SecretBox(randomBytes(32).toString('base64'), 'IDENTITY_ENCRYPTION_KEY'),
  randomBytes(32),
  {} as AuditService,
  new FixedClock(),
);
const slot = { table: 'student_identities', rowId: 'student-1' } as const;
const stored = (value: string, certificate: string | null = null): StudentIdentityRow => {
  const sealed = numbers.protect(value, slot);
  return {
    student_id: 'student-1',
    aadhaar_ciphertext: sealed.ciphertext,
    aadhaar_key_version: sealed.keyVersion,
    aadhaar_hmac: sealed.hmac,
    aadhaar_last4: sealed.last4,
    birth_certificate_number: certificate,
  } as StudentIdentityRow;
};
const certificateOnly = {
  student_id: 'student-1',
  aadhaar_ciphertext: null,
  aadhaar_key_version: null,
  aadhaar_hmac: null,
  aadhaar_last4: null,
  birth_certificate_number: 'BC-1',
} as StudentIdentityRow;
const cleared = { ...certificateOnly, birth_certificate_number: null } as StudentIdentityRow;

const student = (overrides: Partial<StudentRow> = {}): StudentRow =>
  ({
    id: 'student-1',
    society_id: 'society-1',
    institution_id: 'institution-1',
    status: 1,
    ...overrides,
  }) as StudentRow;

const unique = () =>
  Object.assign(new Error('unique'), {
    code: '23505',
    constraint: 'uq_student_identities_institution_aadhaar',
  });

const refusal = async (work: Promise<unknown>) => {
  try {
    await work;
  } catch (error) {
    if (error instanceof AppException) return { status: error.status as number, code: error.code };
    throw error;
  }
  throw new Error('expected a refusal');
};

function build(held?: StudentIdentityRow, current: StudentRow | undefined = student()) {
  const tx = {} as Tx;
  const transaction = vi.fn<DatabaseService['transaction']>((_tenant, work) => work(tx));
  const find = vi.fn<StudentRepository['find']>().mockResolvedValue(current);
  const identityFind = vi.fn<StudentIdentityRepository['find']>().mockResolvedValue(held);
  const holderOf = vi.fn<StudentIdentityRepository['holderOf']>().mockResolvedValue(undefined);
  const heldElsewhere = vi
    .fn<StudentIdentityRepository['heldElsewhere']>()
    .mockResolvedValue(false);
  const put = vi.fn<StudentIdentityRepository['put']>().mockResolvedValue();
  const record = vi.fn<AuditService['record']>().mockResolvedValue('audit-1');
  const requireInstitution = vi.fn<ScopeService['requireInstitution']>().mockResolvedValue({
    institutionId: 'institution-1',
    societyId: 'society-1',
    tenant: { societyId: 'society-1', institutionIds: ['institution-1'] },
  });
  const forPrincipal = vi
    .fn<ScopeService['forPrincipal']>()
    .mockResolvedValue({ tenant: { societyId: 'society-1' } } as Awaited<
      ReturnType<ScopeService['forPrincipal']>
    >);
  const database = { transaction } as unknown as DatabaseService;
  const repository = { find } as unknown as StudentRepository;
  const scope = { requireInstitution, forPrincipal } as unknown as ScopeService;
  const reveal = vi.spyOn(numbers, 'reveal').mockClear().mockResolvedValue('234567890124');
  const service = new StudentIdentityService(
    database,
    repository,
    new StudentContext(database, repository, scope),
    { find: identityFind, holderOf, heldElsewhere, put } as unknown as StudentIdentityRepository,
    numbers,
    { record } as unknown as AuditService,
    new FixedClock('2026-11-12T04:30:00.000Z'),
  );
  return {
    service,
    tx,
    transaction,
    find,
    identityFind,
    holderOf,
    heldElsewhere,
    put,
    record,
    reveal,
    requireInstitution,
  };
}

describe('StudentIdentityService.seal', () => {
  it('seals a number for the student it will belong to', () => {
    const sealed = build().service.seal('student-1', { aadhaarNumber: NUMBER });
    expect(sealed).toMatchObject({ last4: '0124' });
    expect(sealed!.hmac).toHaveLength(32);
  });

  it.each([
    ['an identity left out', undefined, undefined],
    ['a number left out', { birthCertificateNumber: 'BC-1' }, undefined],
    ['null: the number is cleared', { aadhaarNumber: null }, null],
  ])('passes %s on as it is', (_name, body, expected) => {
    expect(build().service.seal('student-1', body)).toBe(expected);
  });

  it.each(['12', '1234 5678 9012', 'abcd'])('is 422 INVALID_AADHAAR for %j', (value) => {
    expect(() => build().service.seal('student-1', { aadhaarNumber: value })).toThrow(
      expect.objectContaining({ status: 422, code: 'INVALID_AADHAAR' }),
    );
  });
});

describe('StudentIdentityService.set (STU-10)', () => {
  it('seals a new number, answers with it masked and audits it without the number', async () => {
    const t = build();
    t.identityFind.mockResolvedValueOnce(undefined).mockResolvedValueOnce(stored(NUMBER, 'BC-1'));
    t.find.mockResolvedValue(student());
    const result = await t.service.set(admin, 'student-1', {
      aadhaarNumber: NUMBER,
      birthCertificateNumber: ' BC-1 ',
    });
    expect(result.data).toEqual({
      aadhaarMasked: 'XXXX XXXX 0124',
      birthCertificateNumber: 'BC-1',
    });
    expect(result.options.meta).toBeNull();
    expect(t.put.mock.calls[0]![1]).toEqual({
      studentId: 'student-1',
      societyId: 'society-1',
      institutionId: 'institution-1',
      by: 'admin-1',
    });
    expect(t.put.mock.calls[0]![2].aadhaar!.last4).toBe('0124');
    expect(t.put.mock.calls[0]![2].birthCertificateNumber).toBe('BC-1');
    expect(t.record.mock.calls[0]![1]).toEqual({
      action: 'identity.updated',
      institutionId: 'institution-1',
      entityType: 'student_identities',
      entityId: 'student-1',
      before: { aadhaarMasked: null, birthCertificateNumber: null },
      after: { aadhaarMasked: 'XXXX XXXX 0124', birthCertificateNumber: 'BC-1' },
    });
    expect(JSON.stringify(t.record.mock.calls)).not.toContain('234567890124');
  });

  it('opens the Institution of the student, and locks the student before it reads the numbers', async () => {
    const t = build();
    await t.service.set(admin, 'student-1', { birthCertificateNumber: 'BC-1' });
    expect(t.requireInstitution).toHaveBeenCalledWith(admin, 'institution-1');
    expect(t.find.mock.calls.at(-1)).toEqual([expect.anything(), 'student-1', true]);
    expect(t.find.mock.invocationCallOrder.at(-1)!).toBeLessThan(
      t.identityFind.mock.invocationCallOrder[0]!,
    );
  });

  it('writes only the number that is sent, and leaves the other alone', async () => {
    const t = build(certificateOnly);
    await t.service.set(admin, 'student-1', { aadhaarNumber: NUMBER });
    expect(Object.keys(t.put.mock.calls[0]![2])).toEqual(['aadhaar']);
    const other = build(stored(NUMBER, 'BC-1'));
    await other.service.set(admin, 'student-1', { birthCertificateNumber: 'BC-2' });
    expect(Object.keys(other.put.mock.calls[0]![2])).toEqual(['birthCertificateNumber']);
  });

  it('writes nothing for the numbers that already stand, no version and no audit entry', async () => {
    const t = build(stored(NUMBER, 'BC-1'));
    const result = await t.service.set(admin, 'student-1', {
      aadhaarNumber: NUMBER.replaceAll(' ', '-'),
      birthCertificateNumber: 'BC-1',
    });
    expect(t.put).not.toHaveBeenCalled();
    expect(t.record).not.toHaveBeenCalled();
    expect(result.data).toEqual({
      aadhaarMasked: 'XXXX XXXX 0124',
      birthCertificateNumber: 'BC-1',
    });
  });

  it('writes nothing for an empty body, and for clearing what is not set', async () => {
    const t = build();
    await t.service.set(admin, 'student-1', {});
    await t.service.set(admin, 'student-1', { aadhaarNumber: null, birthCertificateNumber: null });
    expect(t.put).not.toHaveBeenCalled();
    expect(t.record).not.toHaveBeenCalled();
  });

  it('clears one number and keeps the other, as an update; clearing the last is audited as cleared', async () => {
    const t = build(stored(NUMBER, 'BC-1'));
    t.identityFind
      .mockResolvedValueOnce(stored(NUMBER, 'BC-1'))
      .mockResolvedValueOnce(certificateOnly);
    await t.service.set(admin, 'student-1', { aadhaarNumber: null });
    expect(t.put.mock.calls[0]![2]).toEqual({ aadhaar: null });
    expect(t.record.mock.calls[0]![1]).toMatchObject({
      action: 'identity.updated',
      before: { aadhaarMasked: 'XXXX XXXX 0124', birthCertificateNumber: 'BC-1' },
      after: { aadhaarMasked: null, birthCertificateNumber: 'BC-1' },
    });
    const last = build();
    last.identityFind.mockResolvedValueOnce(certificateOnly).mockResolvedValueOnce(cleared);
    await last.service.set(admin, 'student-1', { birthCertificateNumber: null });
    expect(last.record.mock.calls[0]![1]).toMatchObject({ action: 'identity.cleared' });
  });

  it('does not look for another holder when the number is cleared', async () => {
    const t = build(stored(NUMBER));
    await t.service.set(admin, 'student-1', { aadhaarNumber: null });
    expect(t.holderOf).not.toHaveBeenCalled();
    expect(t.heldElsewhere).not.toHaveBeenCalled();
  });

  it('is 409 AADHAAR_DUPLICATE_IN_INSTITUTION when another active student of the Institution holds the number, writing nothing', async () => {
    const t = build();
    t.holderOf.mockResolvedValue({ studentId: 'student-2', status: 1 });
    expect(await refusal(t.service.set(admin, 'student-1', { aadhaarNumber: NUMBER }))).toEqual({
      status: 409,
      code: 'AADHAAR_DUPLICATE_IN_INSTITUTION',
    });
    expect(t.holderOf.mock.calls[0]!.slice(1, 2)).toEqual(['institution-1']);
    expect(t.holderOf.mock.calls[0]![3]).toBe('student-1');
    expect(t.put).not.toHaveBeenCalled();
    expect(t.record).not.toHaveBeenCalled();
  });

  it('takes the number from a deactivated student of the Institution, audited on that record with who took it', async () => {
    const t = build();
    t.holderOf.mockResolvedValue({ studentId: 'student-2', status: 0 });
    await t.service.set(admin, 'student-1', { aadhaarNumber: NUMBER });
    expect(t.put.mock.calls[0]![1]).toMatchObject({
      studentId: 'student-2',
      institutionId: 'institution-1',
    });
    expect(t.put.mock.calls[0]![2]).toEqual({ aadhaar: null });
    expect(t.put.mock.calls[1]![1]).toMatchObject({ studentId: 'student-1' });
    expect(t.record.mock.calls[0]![1]).toEqual({
      action: 'identity.released',
      institutionId: 'institution-1',
      entityType: 'student_identities',
      entityId: 'student-2',
      before: { aadhaarMasked: 'XXXX XXXX 0124' },
      after: { aadhaarMasked: null, takenBy: 'student-1' },
    });
  });

  it.each([
    [false, null],
    [true, { warnings: ['AADHAAR_EXISTS_IN_SOCIETY'] }],
  ])(
    'with the number held at another Institution of the Society (%s) answers meta %j and still writes',
    async (elsewhere, meta) => {
      const t = build();
      t.heldElsewhere.mockResolvedValue(elsewhere);
      const result = await t.service.set(admin, 'student-1', { aadhaarNumber: NUMBER });
      expect(t.heldElsewhere.mock.calls[0]![1]).toBe('institution-1');
      expect(result.options.meta).toEqual(meta);
      expect(t.put).toHaveBeenCalledTimes(1);
    },
  );

  it('warns again for the same number sent again, which writes nothing', async () => {
    const t = build(stored(NUMBER));
    t.heldElsewhere.mockResolvedValue(true);
    const result = await t.service.set(admin, 'student-1', { aadhaarNumber: NUMBER });
    expect(t.put).not.toHaveBeenCalled();
    expect(result.options.meta).toEqual({ warnings: ['AADHAAR_EXISTS_IN_SOCIETY'] });
  });

  it('turns the unique index into 409 when two students claim a number at once', async () => {
    const t = build();
    t.put.mockRejectedValueOnce(unique());
    expect(await refusal(t.service.set(admin, 'student-1', { aadhaarNumber: NUMBER }))).toEqual({
      status: 409,
      code: 'AADHAAR_DUPLICATE_IN_INSTITUTION',
    });
  });

  it('lets any other failure through', async () => {
    const t = build();
    t.put.mockRejectedValueOnce(new Error('boom'));
    await expect(t.service.set(admin, 'student-1', { aadhaarNumber: NUMBER })).rejects.toThrow(
      'boom',
    );
  });

  it('is 422 for a number that is not one, before a transaction, and 404 for a deactivated student', async () => {
    const t = build();
    expect(await refusal(t.service.set(admin, 'student-1', { aadhaarNumber: '12' }))).toEqual({
      status: 422,
      code: 'INVALID_AADHAAR',
    });
    expect(t.put).not.toHaveBeenCalled();
    const gone = build(undefined, student({ status: 0 }));
    expect(
      (await refusal(gone.service.set(admin, 'student-1', { aadhaarNumber: NUMBER }))).status,
    ).toBe(404);
  });
});

describe('StudentIdentityService.reveal (STU-11)', () => {
  const body = { field: 'aadhaar', reason: 'Checking the transfer certificate' } as const;

  it('returns the number with the reason passed on, for the Institution of the student', async () => {
    const t = build(stored(NUMBER));
    expect(await t.service.reveal(admin, 'student-1', body)).toEqual({
      field: 'aadhaar',
      value: '234567890124',
      revealedAt: '2026-11-12T04:30:00.000Z',
    });
    expect(t.reveal.mock.calls[0]![1]).toMatchObject({
      slot: { table: 'student_identities', rowId: 'student-1' },
      institutionId: 'institution-1',
      reason: 'Checking the transfer certificate',
    });
  });

  it('still answers for a deactivated student, whose number is on file', async () => {
    const t = build(stored(NUMBER), student({ status: 0 }));
    expect((await t.service.reveal(admin, 'student-1', body)).value).toBe('234567890124');
  });

  it.each([[undefined], [cleared], [certificateOnly]])(
    'answers 404 NOT_SET when no Aadhaar number is held (%#)',
    async (held) => {
      const t = build(held);
      expect(await refusal(t.service.reveal(admin, 'student-1', body))).toEqual({
        status: 404,
        code: 'NOT_SET',
      });
      expect(t.reveal).not.toHaveBeenCalled();
    },
  );
});
