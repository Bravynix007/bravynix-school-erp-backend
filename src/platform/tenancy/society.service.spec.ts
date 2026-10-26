import { HttpStatus } from '@nestjs/common';
import type { Principal } from '../../common/auth/access-token-verifier.js';
import { AppException } from '../../common/http/app-exception.js';
import { FixedClock } from '../../common/time/clock.js';
import type { AuditService } from '../audit/index.js';
import type { DatabaseService, Tx } from '../database/index.js';
import type { GrantDirectory, PersonDirectory } from '../identity/index.js';
import type { ListSocietiesQueryDto, UpdateSocietyDto } from './society.dto.js';
import type { SocietyRepository, SocietyRow } from './society.repository.js';
import { SOCIETY_DEACTIVATED, SocietyService } from './society.service.js';

const principal: Principal = {
  personId: 'admin-1',
  sessionId: 'session-1',
  roleCode: 1,
  societyId: null,
  clientType: 'console',
  viaSupportAccess: false,
};

const society = (overrides: Partial<SocietyRow> = {}): SocietyRow => ({
  id: 'society-1',
  created_at: new Date('2026-10-01T00:00:00.000Z'),
  created_by: 'admin-1',
  updated_at: new Date('2026-10-01T00:00:00.000Z'),
  updated_by: 'admin-1',
  version: 2,
  status: 1,
  name: 'Sunrise',
  code: 'SUN',
  description: 'Old',
  email: null,
  country_code: null,
  phone_number: null,
  website: null,
  founded_date: null,
  address_line_1: null,
  address_line_2: null,
  pincode: null,
  access_paused_at: null,
  access_paused_by: null,
  access_pause_reason: null,
  institution_count: 0,
  ...overrides,
});

function build(current: SocietyRow | null = society()) {
  const tx = {} as Tx;
  const transaction = vi.fn<DatabaseService['transaction']>((_tenant, work) => work(tx));
  const find = vi.fn<SocietyRepository['find']>().mockResolvedValue(current ?? undefined);
  const update = vi.fn<SocietyRepository['update']>().mockResolvedValue();
  const insert = vi.fn<SocietyRepository['insert']>().mockResolvedValue();
  const page = vi.fn<SocietyRepository['page']>().mockResolvedValue({ rows: [], total: 0 });
  const record = vi.fn<AuditService['record']>().mockResolvedValue('audit-1');
  const endAccessInSociety = vi
    .fn<GrantDirectory['endAccessInSociety']>()
    .mockResolvedValue({ grantsRevoked: 2, sessionsEnded: 1 });
  const service = new SocietyService(
    { transaction } as unknown as DatabaseService,
    { find, update, insert, page } as unknown as SocietyRepository,
    {
      describe: vi.fn<PersonDirectory['describe']>().mockResolvedValue(new Map()),
    } as unknown as PersonDirectory,
    { endAccessInSociety } as unknown as GrantDirectory,
    { record } as unknown as AuditService,
    new FixedClock('2026-10-26T10:00:00.000Z'),
  );
  return { service, transaction, find, update, insert, page, record, endAccessInSociety, tx };
}

async function refusal(work: Promise<unknown>): Promise<AppException> {
  try {
    await work;
  } catch (error) {
    if (error instanceof AppException) return error;
    throw error;
  }
  throw new Error('expected a refusal');
}

const query = (overrides: Partial<ListSocietiesQueryDto> = {}) =>
  ({ page: 2, limit: 10, ...overrides }) as ListSocietiesQueryDto;

const patch = (body: Partial<UpdateSocietyDto> & { version: number }) => body as UpdateSocietyDto;

describe('SocietyService', () => {
  describe('acting as Super Admin in the Society it changes', () => {
    it('opens every change in that Society, so the audit entry may carry its ID', async () => {
      const t = build();
      await t.service.update(principal, 'society-1', patch({ version: 2, name: 'New' }));
      expect(t.transaction).toHaveBeenCalledWith(
        { personId: 'admin-1', roleCode: 1, societyId: 'society-1' },
        expect.any(Function),
      );
    });
  });

  describe('update', () => {
    it('refuses a stale version and says what the current one is', async () => {
      const t = build();
      const error = await refusal(
        t.service.update(principal, 'society-1', patch({ version: 1, name: 'Late' })),
      );
      expect(error).toMatchObject({
        status: HttpStatus.CONFLICT,
        code: 'VERSION_CONFLICT',
        options: { details: { currentVersion: 2 } },
      });
      expect(t.update).not.toHaveBeenCalled();
      expect(t.record).not.toHaveBeenCalled();
    });

    it('checks the version before the state, so a stale screen reloads first', async () => {
      const t = build(society({ status: 0, version: 5 }));
      const error = await refusal(
        t.service.update(principal, 'society-1', patch({ version: 2, name: 'x' })),
      );
      expect(error.code).toBe('VERSION_CONFLICT');
    });

    it('refuses a deactivated Society', async () => {
      const t = build(society({ status: 0 }));
      const error = await refusal(
        t.service.update(principal, 'society-1', patch({ version: 2, name: 'x' })),
      );
      expect(error).toMatchObject({ status: 409, code: 'INVALID_STATE' });
    });

    it('answers 404 for a Society that is not there', async () => {
      const t = build(null);
      const error = await refusal(
        t.service.update(principal, 'society-1', patch({ version: 1, name: 'x' })),
      );
      expect(error.status).toBe(404);
    });

    it('writes nothing, and keeps the version, when the request changes nothing', async () => {
      const t = build();
      const result = await t.service.update(
        principal,
        'society-1',
        patch({ version: 2, name: 'Sunrise', description: 'Old', email: null }),
      );
      expect(result.version).toBe(2);
      expect(t.update).not.toHaveBeenCalled();
      expect(t.record).not.toHaveBeenCalled();
    });

    it('writes only what differs, lower-cases the email, stamps the author and audits it', async () => {
      const t = build();
      t.find
        .mockResolvedValueOnce(society())
        .mockResolvedValueOnce(society({ version: 3, name: 'New' }));
      await t.service.update(
        principal,
        'society-1',
        patch({ version: 2, name: 'New', description: 'Old', email: 'Office@Sun.ORG' }),
      );
      expect(t.update).toHaveBeenCalledWith(t.tx, 'society-1', {
        name: 'New',
        email: 'office@sun.org',
        updated_by: 'admin-1',
      });
      expect(t.record).toHaveBeenCalledWith(
        t.tx,
        expect.objectContaining({
          action: 'society.update',
          societyId: 'society-1',
          institutionId: null,
          entityType: 'society',
          entityId: 'society-1',
          before: expect.objectContaining({ name: 'Sunrise' }),
          after: expect.objectContaining({ name: 'New' }),
        }),
      );
    });

    it('clears phone and address whole with null, and replaces them whole otherwise', async () => {
      const t = build(
        society({
          country_code: '91',
          phone_number: '9876543210',
          address_line_1: 'A',
          pincode: '1',
        }),
      );
      await t.service.update(
        principal,
        'society-1',
        patch({ version: 2, phone: null, address: { line2: 'B' } }),
      );
      expect(t.update).toHaveBeenCalledWith(t.tx, 'society-1', {
        country_code: null,
        phone_number: null,
        address_line_1: null,
        address_line_2: 'B',
        pincode: null,
        updated_by: 'admin-1',
      });
    });
  });

  describe('create', () => {
    it('maps a taken code, in any letter case, to 409 DUPLICATE on the code field', async () => {
      const t = build();
      t.insert.mockRejectedValue(
        Object.assign(new Error('duplicate key'), {
          code: '23505',
          constraint: 'uq_societies_code_ci',
        }),
      );
      const error = await refusal(t.service.create(principal, { name: 'X', code: 'sun' }));
      expect(error).toMatchObject({
        status: 409,
        code: 'DUPLICATE',
        options: { errors: [expect.objectContaining({ field: 'code', code: 'DUPLICATE' })] },
      });
    });

    it('lets any other database error through unchanged', async () => {
      const t = build();
      const failure = Object.assign(new Error('boom'), { code: '23505', constraint: 'uq_other' });
      t.insert.mockRejectedValue(failure);
      await expect(t.service.create(principal, { name: 'X', code: 'x' })).rejects.toBe(failure);
    });

    it('stamps the author on a new row, in the Society named by its own new ID', async () => {
      const t = build();
      await t.service.create(principal, { name: 'X', code: 'x' });
      const [, values] = t.insert.mock.calls[0]!;
      expect(values).toMatchObject({
        name: 'X',
        code: 'x',
        created_by: 'admin-1',
        updated_by: 'admin-1',
      });
      const tenant = t.transaction.mock.calls[0]![0];
      expect(tenant.societyId).toBe(values.id);
    });
  });

  describe('deactivate', () => {
    it('ends the Society’s access in the same transaction and audits the counts', async () => {
      const t = build();
      await expect(t.service.deactivate(principal, 'society-1')).resolves.toEqual({
        id: 'society-1',
        status: 0,
      });
      expect(t.update).toHaveBeenCalledWith(t.tx, 'society-1', {
        status: 0,
        updated_by: 'admin-1',
      });
      expect(t.endAccessInSociety).toHaveBeenCalledWith(
        t.tx,
        'society-1',
        'admin-1',
        SOCIETY_DEACTIVATED,
        new Date('2026-10-26T10:00:00.000Z'),
      );
      expect(t.record).toHaveBeenCalledWith(
        t.tx,
        expect.objectContaining({
          action: 'society.deactivate',
          before: { status: 1 },
          after: { status: 0, grantsRevoked: 2, sessionsEnded: 1 },
        }),
      );
    });

    it('refuses a Society that is already deactivated, without touching access', async () => {
      const t = build(society({ status: 0 }));
      const error = await refusal(t.service.deactivate(principal, 'society-1'));
      expect(error.code).toBe('INVALID_STATE');
      expect(t.endAccessInSociety).not.toHaveBeenCalled();
    });
  });

  describe('pause and resume', () => {
    it('pauses with the time, the person and the reason, and audits the reason', async () => {
      const t = build();
      await t.service.pause(principal, 'society-1', { version: 2, reason: 'Dues' });
      expect(t.update).toHaveBeenCalledWith(t.tx, 'society-1', {
        access_paused_at: new Date('2026-10-26T10:00:00.000Z'),
        access_paused_by: 'admin-1',
        access_pause_reason: 'Dues',
        updated_by: 'admin-1',
      });
      expect(t.record).toHaveBeenCalledWith(
        t.tx,
        expect.objectContaining({ action: 'access.pause', reason: 'Dues' }),
      );
    });

    it('refuses to pause a Society that is paused or deactivated', async () => {
      const paused = society({
        access_paused_at: new Date(),
        access_paused_by: 'a',
        access_pause_reason: 'x',
      });
      for (const current of [paused, society({ status: 0 })]) {
        const t = build(current);
        const error = await refusal(
          t.service.pause(principal, 'society-1', { version: 2, reason: 'r' }),
        );
        expect(error.code).toBe('INVALID_STATE');
        expect(t.update).not.toHaveBeenCalled();
      }
    });

    it('resumes a paused Society and refuses one that is not paused', async () => {
      const paused = society({
        access_paused_at: new Date(),
        access_paused_by: 'a',
        access_pause_reason: 'x',
      });
      const t = build(paused);
      await t.service.resume(principal, 'society-1', { version: 2 });
      expect(t.update).toHaveBeenCalledWith(t.tx, 'society-1', {
        access_paused_at: null,
        access_paused_by: null,
        access_pause_reason: null,
        updated_by: 'admin-1',
      });
      expect(t.record).toHaveBeenCalledWith(
        t.tx,
        expect.objectContaining({ action: 'access.resume' }),
      );

      const idle = build();
      const error = await refusal(idle.service.resume(principal, 'society-1', { version: 2 }));
      expect(error.code).toBe('INVALID_STATE');
    });
  });

  describe('list', () => {
    it('sorts by name unless asked, and pages by offset', async () => {
      const t = build();
      await t.service.list(principal, query());
      expect(t.page).toHaveBeenCalledWith(
        t.tx,
        { q: undefined, statuses: undefined, paused: undefined },
        [{ field: 'name', direction: 'asc' }],
        10,
        10,
      );
    });

    it('refuses a sort field the list does not offer', async () => {
      const t = build();
      const error = await refusal(t.service.list(principal, query({ sort: 'email' })));
      expect(error).toMatchObject({ status: 400, code: 'INVALID_SORT' });
    });
  });
});
