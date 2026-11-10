import { randomBytes } from 'node:crypto';
import type { Principal } from '../../common/auth/access-token-verifier.js';
import { AppException } from '../../common/http/app-exception.js';
import { FixedClock } from '../../common/time/clock.js';
import type { AuditService } from '../../platform/audit/index.js';
import { SecretBox } from '../../platform/crypto/index.js';
import type { DatabaseService, Tx } from '../../platform/database/index.js';
import { IdentityNumbers } from '../../platform/identity-numbers/index.js';
import type { IdentityRepository, IdentityRow } from './identity.repository.js';
import { StaffContext } from './staff-context.js';
import { StaffIdentityService } from './staff-identity.service.js';
import type { StaffRepository, StaffRow } from './staff.repository.js';
import type { ScopeService } from '../../platform/tenancy/index.js';

const NUMBER = '2345 6789 0124';
const OTHER = '9876 5432 1096';
const admin = { personId: 'admin-1', roleCode: 3, societyId: 'society-1' } as unknown as Principal;

const numbers = new IdentityNumbers(
  new SecretBox(randomBytes(32).toString('base64'), 'IDENTITY_ENCRYPTION_KEY'),
  randomBytes(32),
  {} as AuditService,
  new FixedClock(),
);
const slot = { table: 'staff_identities', rowId: 'staff-1' } as const;
const stored = (value: string): IdentityRow => {
  const sealed = numbers.protect(value, slot);
  return {
    staff_member_id: 'staff-1',
    aadhaar_ciphertext: sealed.ciphertext,
    aadhaar_key_version: sealed.keyVersion,
    aadhaar_hmac: sealed.hmac,
    aadhaar_last4: sealed.last4,
  } as IdentityRow;
};
const cleared = {
  staff_member_id: 'staff-1',
  aadhaar_last4: null,
  aadhaar_hmac: null,
} as IdentityRow;

const staff = (overrides: Partial<StaffRow> = {}): StaffRow =>
  ({
    id: 'staff-1',
    society_id: 'society-1',
    home_institution_id: 'institution-1',
    user_id: 'user-1',
    status: 1,
    ...overrides,
  }) as StaffRow;

const unique = () =>
  Object.assign(new Error('unique'), {
    code: '23505',
    constraint: 'uq_staff_identities_society_aadhaar',
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

function build(held?: IdentityRow, current: StaffRow | undefined = staff()) {
  const tx = {} as Tx;
  const transaction = vi.fn<DatabaseService['transaction']>((_tenant, work) => work(tx));
  const find = vi.fn<StaffRepository['find']>().mockResolvedValue(current);
  const identityFind = vi.fn<IdentityRepository['find']>().mockResolvedValue(held);
  const holderOf = vi.fn<IdentityRepository['holderOf']>().mockResolvedValue(undefined);
  const put = vi.fn<IdentityRepository['put']>().mockResolvedValue();
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
  const repository = { find } as unknown as StaffRepository;
  const scope = { requireInstitution, forPrincipal } as unknown as ScopeService;
  const reveal = vi.spyOn(numbers, 'reveal').mockClear().mockResolvedValue('234567890124');
  const service = new StaffIdentityService(
    database,
    repository,
    new StaffContext(database, repository, scope),
    { find: identityFind, holderOf, put } as unknown as IdentityRepository,
    numbers,
    { record } as unknown as AuditService,
    new FixedClock('2026-11-10T04:30:00.000Z'),
  );
  return { service, find, identityFind, holderOf, put, record, reveal, requireInstitution };
}

describe('StaffIdentityService.set (STF-11)', () => {
  it('seals a new number, answers with the masked one and audits it without the number', async () => {
    const t = build();
    t.identityFind.mockResolvedValueOnce(undefined).mockResolvedValueOnce(stored(NUMBER));
    expect(await t.service.set(admin, 'staff-1', { aadhaar: NUMBER })).toEqual({
      aadhaarMasked: 'XXXX XXXX 0124',
    });
    expect(t.put.mock.calls[0]![1]).toEqual({
      staffMemberId: 'staff-1',
      societyId: 'society-1',
      by: 'admin-1',
    });
    const written = t.put.mock.calls[0]![2]!;
    expect(written.last4).toBe('0124');
    expect(written.ciphertext.includes(Buffer.from('234567890124'))).toBe(false);
    expect(t.record.mock.calls[0]![1]).toEqual({
      action: 'identity.updated',
      institutionId: 'institution-1',
      entityType: 'staff_identity',
      entityId: 'staff-1',
      before: { aadhaarMasked: null },
      after: { aadhaarMasked: 'XXXX XXXX 0124' },
    });
    expect(JSON.stringify(t.record.mock.calls)).not.toContain('234567890124');
  });

  it('writes nothing for the same number again, however it is typed', async () => {
    const t = build(stored(NUMBER));
    expect(await t.service.set(admin, 'staff-1', { aadhaar: '234567890124' })).toEqual({
      aadhaarMasked: 'XXXX XXXX 0124',
    });
    expect(t.put).not.toHaveBeenCalled();
    expect(t.record).not.toHaveBeenCalled();
  });

  it('replaces a number with another, audited with both masked', async () => {
    const t = build(stored(NUMBER));
    await t.service.set(admin, 'staff-1', { aadhaar: OTHER });
    expect(t.record.mock.calls[0]![1]).toMatchObject({
      action: 'identity.updated',
      before: { aadhaarMasked: 'XXXX XXXX 0124' },
      after: { aadhaarMasked: 'XXXX XXXX 1096' },
    });
  });

  it('clears the number with null and keeps the row', async () => {
    const t = build(stored(NUMBER));
    t.identityFind.mockResolvedValueOnce(stored(NUMBER)).mockResolvedValueOnce(cleared);
    expect(await t.service.set(admin, 'staff-1', { aadhaar: null })).toEqual({
      aadhaarMasked: null,
    });
    expect(t.put.mock.calls[0]![2]).toBeNull();
    expect(t.record.mock.calls[0]![1]).toMatchObject({
      action: 'identity.cleared',
      before: { aadhaarMasked: 'XXXX XXXX 0124' },
      after: { aadhaarMasked: null },
    });
  });

  it.each([[undefined], [cleared]])(
    'writes nothing when there is nothing to clear (%#)',
    async (held) => {
      const t = build(held);
      expect(await t.service.set(admin, 'staff-1', { aadhaar: null })).toEqual({
        aadhaarMasked: null,
      });
      expect(t.put).not.toHaveBeenCalled();
    },
  );

  it('answers 422 INVALID_AADHAAR before it reads anything', async () => {
    const t = build();
    expect(await refusal(t.service.set(admin, 'staff-1', { aadhaar: '234567890125' }))).toEqual({
      status: 422,
      code: 'INVALID_AADHAAR',
    });
    expect(t.requireInstitution).toHaveBeenCalled();
    expect(t.put).not.toHaveBeenCalled();
  });

  it('answers 404 for a deactivated record', async () => {
    const t = build(undefined, staff({ status: 0 }));
    expect(await refusal(t.service.set(admin, 'staff-1', { aadhaar: NUMBER }))).toMatchObject({
      status: 404,
    });
  });

  it('refuses a number an active record holds with 409, and writes nothing', async () => {
    const t = build();
    t.holderOf.mockResolvedValue({ staffMemberId: 'staff-2', status: 1 });
    expect(await refusal(t.service.set(admin, 'staff-1', { aadhaar: NUMBER }))).toEqual({
      status: 409,
      code: 'AADHAAR_EXISTS_IN_SOCIETY',
    });
    expect(t.put).not.toHaveBeenCalled();
    expect(t.record).not.toHaveBeenCalled();
  });

  it('takes the number from a deactivated record, clearing it there and auditing both', async () => {
    const t = build();
    t.identityFind.mockResolvedValueOnce(undefined).mockResolvedValueOnce(stored(NUMBER));
    t.holderOf.mockResolvedValue({ staffMemberId: 'staff-9', status: 0 });
    await t.service.set(admin, 'staff-1', { aadhaar: NUMBER });
    expect(t.put.mock.calls.map(([, who, value]) => [who.staffMemberId, value === null])).toEqual([
      ['staff-9', true],
      ['staff-1', false],
    ]);
    expect(t.put.mock.calls[0]![1].by).toBe('admin-1');
    expect(t.record.mock.calls.map(([, entry]) => [entry.action, entry.entityId])).toEqual([
      ['identity.released', 'staff-9'],
      ['identity.updated', 'staff-1'],
    ]);
    expect(t.record.mock.calls[0]![1]).toMatchObject({
      before: { aadhaarMasked: 'XXXX XXXX 0124' },
      after: { aadhaarMasked: null, takenBy: 'staff-1' },
    });
  });

  it('turns the unique index into 409 when two records claim a number at once', async () => {
    const t = build();
    t.put.mockRejectedValueOnce(unique());
    expect(await refusal(t.service.set(admin, 'staff-1', { aadhaar: NUMBER }))).toEqual({
      status: 409,
      code: 'AADHAAR_EXISTS_IN_SOCIETY',
    });
  });

  it('lets any other failure through', async () => {
    const t = build();
    t.put.mockRejectedValueOnce(new Error('boom'));
    await expect(t.service.set(admin, 'staff-1', { aadhaar: NUMBER })).rejects.toThrow('boom');
  });
});

describe('StaffIdentityService.reveal (STF-12)', () => {
  const body = { field: 'aadhaar', reason: 'Payroll verification for the month' } as const;

  it('returns the number with the reason passed on, for the record of the home Institution', async () => {
    const t = build(stored(NUMBER));
    expect(await t.service.reveal(admin, 'staff-1', body)).toEqual({
      field: 'aadhaar',
      value: '234567890124',
      revealedAt: '2026-11-10T04:30:00.000Z',
    });
    expect(t.reveal.mock.calls[0]![1]).toMatchObject({
      slot: { table: 'staff_identities', rowId: 'staff-1' },
      institutionId: 'institution-1',
      reason: 'Payroll verification for the month',
    });
  });

  it('still answers for a deactivated record, whose number is on file', async () => {
    const t = build(stored(NUMBER), staff({ status: 0 }));
    expect((await t.service.reveal(admin, 'staff-1', body)).value).toBe('234567890124');
  });

  it.each([[undefined], [cleared]])(
    'answers 404 NOT_SET when no number is held (%#)',
    async (held) => {
      const t = build(held);
      expect(await refusal(t.service.reveal(admin, 'staff-1', body))).toEqual({
        status: 404,
        code: 'NOT_SET',
      });
      expect(t.reveal).not.toHaveBeenCalled();
    },
  );
});
