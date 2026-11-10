import type { Principal } from '../../common/auth/access-token-verifier.js';
import { AppException } from '../../common/http/app-exception.js';
import type { AuditService } from '../../platform/audit/index.js';
import type { DatabaseService, Tx } from '../../platform/database/index.js';
import type { FileBrief, FileDirectory } from '../../platform/files/index.js';
import type { PersonDirectory } from '../../platform/identity/index.js';
import type { ScopeService } from '../../platform/tenancy/index.js';
import type { DocumentRepository, DocumentRow } from './document.repository.js';
import { DocumentService } from './document.service.js';
import { StaffContext } from './staff-context.js';
import type { StaffRepository, StaffRow } from './staff.repository.js';

const at = new Date('2026-11-10T04:30:00.000Z');
const admin = { personId: 'admin-1', roleCode: 3, societyId: 'society-1' } as unknown as Principal;
const teacher = { personId: 'user-1', roleCode: 4, societyId: 'society-1' } as unknown as Principal;

const staff = (overrides: Partial<StaffRow> = {}): StaffRow =>
  ({
    id: 'staff-1',
    society_id: 'society-1',
    home_institution_id: 'institution-1',
    user_id: 'user-1',
    status: 1,
    ...overrides,
  }) as StaffRow;

const document = (overrides: Partial<DocumentRow> = {}): DocumentRow =>
  ({
    id: 'doc-1',
    created_at: at,
    created_by: 'admin-1',
    updated_at: at,
    updated_by: 'admin-1',
    status: 1,
    society_id: 'society-1',
    institution_id: 'institution-1',
    owner_type: 2,
    staff_member_id: 'staff-1',
    title: 'Appointment letter',
    file_id: 'file-1',
    ...overrides,
  }) as DocumentRow;

const brief: FileBrief = {
  id: 'file-1',
  contentType: 'application/pdf',
  sizeBytes: 1200,
  fileName: 'letter.pdf',
};

const refusal = async (work: Promise<unknown>) => {
  try {
    await work;
  } catch (error) {
    if (error instanceof AppException) return { status: error.status as number, code: error.code };
    throw error;
  }
  throw new Error('expected a refusal');
};

function build(current: StaffRow | undefined = staff(), found: DocumentRow | null = document()) {
  const tx = {} as Tx;
  const transaction = vi.fn<DatabaseService['transaction']>((_tenant, work) => work(tx));
  const staffFind = vi.fn<StaffRepository['find']>().mockResolvedValue(current);
  const find = vi.fn<DocumentRepository['find']>().mockResolvedValue(found ?? undefined);
  const ofStaff = vi.fn<DocumentRepository['ofStaff']>().mockResolvedValue([document()]);
  const insert = vi
    .fn<DocumentRepository['insert']>()
    .mockImplementation((_tx, values) => Promise.resolve(document(values as Partial<DocumentRow>)));
  const deactivate = vi.fn<DocumentRepository['deactivate']>().mockResolvedValue();
  const requireReady = vi.fn<FileDirectory['requireReady']>().mockResolvedValue();
  const briefs = vi.fn<FileDirectory['briefs']>().mockResolvedValue(new Map([['file-1', brief]]));
  const describe = vi.fn<PersonDirectory['describe']>().mockResolvedValue(new Map());
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
  const repository = { find: staffFind } as unknown as StaffRepository;
  const scope = { requireInstitution, forPrincipal } as unknown as ScopeService;
  const service = new DocumentService(
    database,
    { find, ofStaff, insert, deactivate } as unknown as DocumentRepository,
    new StaffContext(database, repository, scope),
    scope,
    { requireReady, briefs } as unknown as FileDirectory,
    { describe } as unknown as PersonDirectory,
    { record } as unknown as AuditService,
  );
  return {
    service,
    find,
    ofStaff,
    insert,
    deactivate,
    requireReady,
    briefs,
    record,
    requireInstitution,
  };
}

describe('DocumentService.list (STF-14)', () => {
  it('lists the documents with the file as a client may see it and the author stamps', async () => {
    const t = build();
    const result = await t.service.list(admin, 'staff-1');
    expect(result.options.meta).toBeNull();
    expect(result.data).toMatchObject([
      {
        id: 'doc-1',
        ownerType: 'staff',
        staffMemberId: 'staff-1',
        title: 'Appointment letter',
        file: brief,
        createdBy: { id: 'admin-1', displayName: 'Unknown' },
        createdAt: '2026-11-10T04:30:00.000Z',
      },
    ]);
  });

  it('is an empty list, with no file read, when there is no document', async () => {
    const t = build();
    t.ofStaff.mockResolvedValue([]);
    expect((await t.service.list(admin, 'staff-1')).data).toEqual([]);
    expect(t.briefs).not.toHaveBeenCalled();
  });

  it('lets a teacher read their own record and answers 404 for another', async () => {
    expect((await build().service.list(teacher, 'staff-1')).data).toHaveLength(1);
    const other = build(staff({ user_id: 'user-2' }));
    expect(await refusal(other.service.list(teacher, 'staff-1'))).toMatchObject({ status: 404 });
  });
});

describe('DocumentService.create (STF-15)', () => {
  const body = { title: 'Appointment letter', fileId: 'file-1' };

  it('attaches a Ready purpose 6 file of the home Institution and audits it', async () => {
    const t = build();
    const created = await t.service.create(admin, 'staff-1', body);
    expect(t.requireReady).toHaveBeenCalledWith(
      expect.anything(),
      'file-1',
      { purpose: 6, institutionId: 'institution-1' },
      'fileId',
    );
    expect(t.insert.mock.calls[0]![1]).toMatchObject({
      society_id: 'society-1',
      institution_id: 'institution-1',
      owner_type: 2,
      staff_member_id: 'staff-1',
      title: 'Appointment letter',
      file_id: 'file-1',
      created_by: 'admin-1',
    });
    expect(t.record.mock.calls[0]![1]).toMatchObject({
      action: 'document.created',
      institutionId: 'institution-1',
      entityType: 'document',
      after: { staffMemberId: 'staff-1', title: 'Appointment letter', fileId: 'file-1' },
    });
    expect(created).toMatchObject({ title: 'Appointment letter', file: brief });
  });

  it('answers 404 for a deactivated record, before it looks at the file', async () => {
    const t = build(staff({ status: 0 }));
    expect(await refusal(t.service.create(admin, 'staff-1', body))).toMatchObject({ status: 404 });
    expect(t.requireReady).not.toHaveBeenCalled();
  });

  it('lets the refusal of a file that is not usable through', async () => {
    const t = build();
    t.requireReady.mockRejectedValueOnce(AppException.notFound());
    expect(await refusal(t.service.create(admin, 'staff-1', body))).toMatchObject({ status: 404 });
    expect(t.insert).not.toHaveBeenCalled();
  });

  it('answers 409 DUPLICATE for a file that is attached already', async () => {
    const t = build();
    t.insert.mockRejectedValueOnce(
      Object.assign(new Error('unique'), { code: '23505', constraint: 'uq_documents_file' }),
    );
    expect(await refusal(t.service.create(admin, 'staff-1', body))).toEqual({
      status: 409,
      code: 'DUPLICATE',
    });
  });

  it('lets any other failure through', async () => {
    const t = build();
    t.insert.mockRejectedValueOnce(new Error('boom'));
    await expect(t.service.create(admin, 'staff-1', body)).rejects.toThrow('boom');
  });
});

describe('DocumentService.deactivate (DOC-03)', () => {
  it('deactivates the document at its Institution and audits it', async () => {
    const t = build();
    expect(await t.service.deactivate(admin, 'doc-1')).toEqual({ id: 'doc-1', status: 0 });
    expect(t.requireInstitution).toHaveBeenCalledWith(admin, 'institution-1');
    expect(t.deactivate).toHaveBeenCalledWith(expect.anything(), 'doc-1', 'admin-1');
    expect(t.record.mock.calls[0]![1]).toMatchObject({
      action: 'document.deactivated',
      institutionId: 'institution-1',
      entityType: 'document',
      entityId: 'doc-1',
      before: { status: 1 },
      after: { status: 0 },
    });
  });

  it.each([
    ['not found', null],
    ['already deactivated', document({ status: 0 })],
  ])('answers 404 for a document that is %s', async (_name, found) => {
    const t = build(staff(), found);
    expect(await refusal(t.service.deactivate(admin, 'doc-1'))).toMatchObject({ status: 404 });
    expect(t.deactivate).not.toHaveBeenCalled();
  });

  it('answers 404 when it is deactivated by another request while this one waits for the lock', async () => {
    const t = build();
    t.find.mockResolvedValueOnce(document()).mockResolvedValueOnce(document({ status: 0 }));
    expect(await refusal(t.service.deactivate(admin, 'doc-1'))).toMatchObject({ status: 404 });
    expect(t.deactivate).not.toHaveBeenCalled();
  });

  it('answers 404 for a document of an Institution the caller does not reach', async () => {
    const t = build();
    t.requireInstitution.mockRejectedValueOnce(AppException.notFound());
    expect(await refusal(t.service.deactivate(admin, 'doc-1'))).toMatchObject({ status: 404 });
    expect(t.deactivate).not.toHaveBeenCalled();
  });
});
