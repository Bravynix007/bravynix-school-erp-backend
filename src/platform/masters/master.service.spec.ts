import type { Principal } from '../../common/auth/access-token-verifier.js';
import { AppException } from '../../common/http/app-exception.js';
import type { AuditService } from '../audit/index.js';
import type { DatabaseService, Tx } from '../database/index.js';
import { MASTER_SPECS } from './master.catalog.js';
import type { MasterQueryDto } from './master.dto.js';
import type { MasterRepository } from './master.repository.js';
import { listEtag, masterEntry, type MasterRow } from './master.resource.js';
import { MasterService } from './master.service.js';

const caller = (roleCode: Principal['roleCode']): Principal => ({
  personId: 'person-1',
  sessionId: 'session-1',
  roleCode,
  societyId: roleCode === 1 ? null : 'society-1',
  clientType: roleCode === 1 ? 'console' : 'mobile',
  viaSupportAccess: false,
});
const superAdmin = caller(1);
const owner = caller(2);

const designations = MASTER_SPECS.designations;
const states = MASTER_SPECS.states;
const countries = MASTER_SPECS.countries;
const id = '00000000-0000-7000-8000-000000000001';

const row = (overrides: Partial<MasterRow> = {}): MasterRow => ({
  id,
  status: 1,
  version: 1,
  code: 'TEACHER',
  name: 'Teacher',
  display_order: 3,
  created_by: 'person-1',
  updated_by: 'person-1',
  ...overrides,
});

const fail = async (work: Promise<unknown>) => {
  try {
    await work;
  } catch (error) {
    if (error instanceof AppException) {
      return { status: error.status as number, body: { code: error.code } };
    }
    throw error;
  }
  throw new Error('expected a refusal');
};

function build(current: MasterRow | null = row(), count = 12) {
  const tx = {} as Tx;
  const transaction = vi.fn<DatabaseService['transaction']>((_tenant, work) => work(tx));
  const list = vi.fn<MasterRepository['list']>().mockResolvedValue([row()]);
  const find = vi.fn<MasterRepository['find']>().mockResolvedValue(current ?? undefined);
  const insert = vi
    .fn<MasterRepository['insert']>()
    .mockImplementation((_tx, _spec, values) => Promise.resolve(row(values)));
  const update = vi
    .fn<MasterRepository['update']>()
    .mockImplementation((_tx, _spec, _id, changes) =>
      Promise.resolve(row({ ...current, ...changes, version: (current?.version ?? 1) + 1 })),
    );
  const statusOf = vi.fn<MasterRepository['statusOf']>().mockResolvedValue(1);
  const countOf = vi.fn<MasterRepository['count']>().mockResolvedValue(count);
  const lockList = vi.fn<MasterRepository['lockList']>().mockResolvedValue();
  const shift = vi.fn<MasterRepository['shift']>().mockResolvedValue();
  const record = vi.fn<AuditService['record']>().mockResolvedValue('audit-1');
  const service = new MasterService(
    { transaction } as unknown as DatabaseService,
    {
      list,
      find,
      insert,
      update,
      statusOf,
      count: countOf,
      lockList,
      shift,
    } as unknown as MasterRepository,
    { record } as unknown as AuditService,
  );
  return { service, transaction, list, find, insert, update, statusOf, lockList, shift, record };
}

describe('MasterService', () => {
  describe('list (MST-01)', () => {
    it('answers the shown entries with a weak tag, five minutes of cache and Vary', async () => {
      const t = build();
      const result = await t.service.list(owner, designations, {} as MasterQueryDto);
      const entries = [masterEntry(designations, row())];
      expect(result.data).toEqual(entries);
      expect(result.options?.status).toBe(200);
      expect(result.options?.headers).toEqual({
        ETag: listEtag(entries),
        'Cache-Control': 'private, max-age=300',
        Vary: 'Authorization',
      });
      expect(t.list).toHaveBeenCalledWith(expect.anything(), designations, {
        includeHidden: false,
        filters: [],
      });
    });

    it('lets Super Admin include hidden entries, never cached without asking; others get 403', async () => {
      const t = build();
      const query = { includeHidden: true } as MasterQueryDto;
      const result = await t.service.list(superAdmin, designations, query);
      expect(result.options?.headers).toMatchObject({ 'Cache-Control': 'private, no-cache' });
      expect(await fail(t.service.list(owner, designations, query))).toMatchObject({
        status: 403,
      });
    });
  });

  describe('create (PLT-31)', () => {
    it('adds an ordered entry last, under the list lock, with its audit entry', async () => {
      const t = build(null, 12);
      const entry = await t.service.create(superAdmin, designations, {
        code: 'COUNSELLOR',
        name: 'Counsellor',
      });
      expect(t.lockList).toHaveBeenCalledWith(expect.anything(), designations);
      expect(t.shift).not.toHaveBeenCalled();
      expect(t.insert.mock.calls[0]![2]).toMatchObject({
        code: 'COUNSELLOR',
        name: 'Counsellor',
        display_order: 13,
      });
      expect(entry).toMatchObject({ code: 'COUNSELLOR', displayOrder: 13 });
      expect(t.record).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: 'platform.master.created',
          societyId: null,
          institutionId: null,
          entityType: 'designation',
        }),
      );
    });

    it('inserts at a position and shifts the entries from there down one', async () => {
      const t = build(null, 12);
      await t.service.create(superAdmin, designations, {
        code: 'COUNSELLOR',
        name: 'Counsellor',
        displayOrder: 2,
      });
      expect(t.shift).toHaveBeenCalledWith(
        expect.anything(),
        designations,
        { from: 2, to: 12 },
        1,
        'person-1',
      );
      expect(t.insert.mock.calls[0]![2]).toMatchObject({ display_order: 2 });
    });

    it('is 404 for a parent that does not exist and 422 for a hidden one, writing nothing', async () => {
      const t = build();
      t.statusOf.mockResolvedValueOnce(undefined);
      expect(
        await fail(t.service.create(superAdmin, states, { countryId: id, name: 'Alpha' })),
      ).toMatchObject({ status: 404 });
      t.statusOf.mockResolvedValueOnce(0);
      expect(
        await fail(t.service.create(superAdmin, states, { countryId: id, name: 'Alpha' })),
      ).toMatchObject({
        status: 422,
        body: expect.objectContaining({ code: 'REFERENCE_INACTIVE' }),
      });
      expect(t.insert).not.toHaveBeenCalled();
      expect(t.lockList).not.toHaveBeenCalled();
    });

    it('turns a unique violation into 409 DUPLICATE on its field', async () => {
      const t = build();
      t.insert.mockRejectedValueOnce(
        Object.assign(new Error('duplicate'), { code: '23505', constraint: 'uq_countries_iso2' }),
      );
      expect(
        await fail(t.service.create(superAdmin, countries, { name: 'Zed', iso2: 'IN' })),
      ).toMatchObject({ status: 409 });
    });
  });

  describe('update (PLT-32)', () => {
    it('checks the version first', async () => {
      const t = build(row({ version: 3 }));
      expect(
        await fail(t.service.update(superAdmin, designations, id, { version: 2, name: 'X' })),
      ).toMatchObject({ status: 409 });
      expect(t.update).not.toHaveBeenCalled();
    });

    it('writes nothing when nothing changes', async () => {
      const t = build();
      const entry = await t.service.update(superAdmin, designations, id, {
        version: 1,
        name: 'Teacher',
        displayOrder: 3,
      });
      expect(entry).toMatchObject({ version: 1 });
      expect(t.update).not.toHaveBeenCalled();
      expect(t.shift).not.toHaveBeenCalled();
      expect(t.record).not.toHaveBeenCalled();
    });

    it('moves the entry, shifting the ones it passes, and audits an update', async () => {
      const t = build(row({ display_order: 5 }));
      await t.service.update(superAdmin, designations, id, { version: 1, displayOrder: 2 });
      expect(t.shift).toHaveBeenCalledWith(
        expect.anything(),
        designations,
        { from: 2, to: 4 },
        1,
        'person-1',
      );
      expect(t.update.mock.calls[0]![3]).toMatchObject({ display_order: 2 });
      expect(t.record.mock.calls[0]![1]).toMatchObject({
        action: 'platform.master.updated',
        before: expect.objectContaining({ display_order: 5 }),
      });
    });

    it('audits a status-only change as hidden or shown, and status with a name as updated', async () => {
      const t = build();
      await t.service.update(superAdmin, designations, id, { version: 1, status: 0 });
      expect(t.record.mock.calls[0]![1]).toMatchObject({ action: 'platform.master.hidden' });

      const shown = build(row({ status: 0 }));
      await shown.service.update(superAdmin, designations, id, { version: 1, status: 1 });
      expect(shown.record.mock.calls[0]![1]).toMatchObject({ action: 'platform.master.shown' });

      const both = build();
      await both.service.update(superAdmin, designations, id, {
        version: 1,
        status: 0,
        name: 'Tutor',
      });
      expect(both.record.mock.calls[0]![1]).toMatchObject({ action: 'platform.master.updated' });
    });

    it('is 404 for an unknown entry', async () => {
      const t = build(null);
      expect(
        await fail(t.service.update(superAdmin, designations, id, { version: 1, name: 'X' })),
      ).toMatchObject({ status: 404 });
    });

    it('takes no list lock for a place, which has no order', async () => {
      const t = build(row({ name: 'Alpha', country_id: id, iso2: null }));
      await t.service.update(superAdmin, states, id, { version: 1, name: 'Beta' });
      expect(t.lockList).not.toHaveBeenCalled();
      expect(t.update.mock.calls[0]![3]).toMatchObject({ name: 'Beta' });
    });
  });

  describe('hide (PLT-33)', () => {
    it('hides a shown entry and audits it', async () => {
      const t = build();
      expect(await t.service.hide(superAdmin, designations, id)).toEqual({ id, status: 0 });
      expect(t.update.mock.calls[0]![3]).toMatchObject({ status: 0 });
      expect(t.record.mock.calls[0]![1]).toMatchObject({
        action: 'platform.master.hidden',
        societyId: null,
      });
    });

    it('is 409 INVALID_STATE when already hidden, and 404 when unknown', async () => {
      expect(
        await fail(build(row({ status: 0 })).service.hide(superAdmin, designations, id)),
      ).toMatchObject({
        status: 409,
        body: expect.objectContaining({ code: 'INVALID_STATE' }),
      });
      expect(await fail(build(null).service.hide(superAdmin, designations, id))).toMatchObject({
        status: 404,
      });
    });
  });
});
