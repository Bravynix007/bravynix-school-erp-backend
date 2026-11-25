import type { Principal } from '../../common/auth/access-token-verifier.js';
import { AppException } from '../../common/http/app-exception.js';
import { FixedClock } from '../../common/time/clock.js';
import type { AuditService } from '../../platform/audit/index.js';
import type { DatabaseService, TenantContext, Tx } from '../../platform/database/index.js';
import type { PersonDirectory } from '../../platform/identity/index.js';
import type { InstitutionContext, ScopeService } from '../../platform/tenancy/index.js';
import type { DatesheetNotifier } from './datesheet.notifier.js';
import { DatesheetService } from './datesheet.service.js';
import type { ExamPaperRepository, ExamPaperRow } from './exam-paper.repository.js';
import type { ExamRepository, ExamRow } from './exam.repository.js';

const admin = { personId: 'person-1', roleCode: 3, societyId: 'society-1' } as Principal;
const tenant: TenantContext = {
  personId: 'person-1',
  roleCode: 3,
  societyId: 'society-1',
  institutionIds: ['inst-1', 'inst-2'],
};
const narrowed: TenantContext = { ...tenant, institutionIds: ['inst-1'] };
const context: InstitutionContext = {
  institutionId: 'inst-1',
  societyId: 'society-1',
  tenant: narrowed,
};

const exam = (overrides: Partial<ExamRow> = {}): ExamRow => ({
  id: 'exam-1',
  created_at: new Date('2026-11-01T00:00:00.000Z'),
  created_by: 'person-1',
  updated_at: new Date('2026-11-01T00:00:00.000Z'),
  updated_by: 'person-1',
  version: 1,
  status: 1,
  society_id: 'society-1',
  institution_id: 'inst-1',
  academic_year_id: 'year-1',
  name: 'Unit Test 1',
  exam_type: 1,
  start_date: '2026-08-10',
  end_date: '2026-08-14',
  datesheet_published_at: null,
  datesheet_published_by: null,
  ...overrides,
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

function build(found: ExamRow | null = exam(), papers: ExamPaperRow[] = [{} as ExamPaperRow]) {
  const tx = {} as Tx;
  const transaction = vi.fn<DatabaseService['transaction']>((_tenant, work) => work(tx));
  const find = vi.fn<ExamRepository['find']>().mockResolvedValue(found ?? undefined);
  const update = vi
    .fn<ExamRepository['update']>()
    .mockImplementation((_tx, id, changes) =>
      Promise.resolve(exam({ ...found, ...(changes as Partial<ExamRow>), id, version: 2 })),
    );
  const ofExam = vi.fn<ExamPaperRepository['ofExam']>().mockResolvedValue(papers);
  const forPrincipal = vi
    .fn<ScopeService['forPrincipal']>()
    .mockResolvedValue({ tenant, societyId: 'society-1' } as Awaited<
      ReturnType<ScopeService['forPrincipal']>
    >);
  const requireInstitution = vi.fn<ScopeService['requireInstitution']>().mockResolvedValue(context);
  const published = vi.fn<DatesheetNotifier['published']>().mockResolvedValue();
  const record = vi.fn<AuditService['record']>().mockResolvedValue('audit-1');
  const service = new DatesheetService(
    { transaction } as unknown as DatabaseService,
    { find, update } as unknown as ExamRepository,
    { ofExam } as unknown as ExamPaperRepository,
    { forPrincipal, requireInstitution } as unknown as ScopeService,
    { published } as unknown as DatesheetNotifier,
    new FixedClock('2026-08-01T04:30:00.000Z'),
    {
      describe: vi.fn<PersonDirectory['describe']>().mockResolvedValue(new Map()),
    } as unknown as PersonDirectory,
    { record } as unknown as AuditService,
  );
  return { service, transaction, find, update, ofExam, requireInstitution, published, record };
}

describe('DatesheetService.publish', () => {
  it('stamps the exam, audits it and tells the papers’ people in the same transaction', async () => {
    const t = build();
    const result = await t.service.publish(admin, 'exam-1');
    expect(t.requireInstitution).toHaveBeenCalledWith(admin, 'inst-1');
    expect(t.transaction).toHaveBeenLastCalledWith(narrowed, expect.any(Function));
    expect(t.update).toHaveBeenCalledWith(
      expect.anything(),
      'exam-1',
      expect.objectContaining({
        datesheet_published_at: new Date('2026-08-01T04:30:00.000Z'),
        datesheet_published_by: 'person-1',
        updated_by: 'person-1',
      }),
    );
    expect(result).toMatchObject({
      id: 'exam-1',
      datesheetPublishedAt: '2026-08-01T04:30:00.000Z',
    });
    expect(t.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'exam.datesheet_published',
        entityId: 'exam-1',
        institutionId: 'inst-1',
        before: expect.objectContaining({ datesheet_published_at: null }),
        after: expect.objectContaining({ datesheet_published_at: '2026-08-01T04:30:00.000Z' }),
      }),
    );
    expect(t.published).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: 'exam-1' }),
      [{}],
      'person-1',
    );
  });

  it('is 404 for an exam that is gone, deactivated or out of reach', async () => {
    expect(await refusal(build(null).service.publish(admin, 'exam-1'))).toEqual({
      status: 404,
      code: 'NOT_FOUND',
    });
    expect(
      await refusal(build(exam({ status: 0 })).service.publish(admin, 'exam-1')),
    ).toMatchObject({ status: 404 });
    const t = build();
    t.requireInstitution.mockRejectedValueOnce(AppException.notFound());
    expect(await refusal(t.service.publish(admin, 'exam-1'))).toMatchObject({ status: 404 });
    expect(t.update).not.toHaveBeenCalled();
  });

  it('is 409 DATESHEET_PUBLISHED once it is out, and writes and tells no one', async () => {
    const t = build(
      exam({ datesheet_published_at: new Date(), datesheet_published_by: 'person-1' }),
    );
    expect(await refusal(t.service.publish(admin, 'exam-1'))).toEqual({
      status: 409,
      code: 'DATESHEET_PUBLISHED',
    });
    expect(t.update).not.toHaveBeenCalled();
    expect(t.record).not.toHaveBeenCalled();
    expect(t.published).not.toHaveBeenCalled();
  });

  it('is 422 DATESHEET_EMPTY without an active paper', async () => {
    const t = build(exam(), []);
    expect(await refusal(t.service.publish(admin, 'exam-1'))).toEqual({
      status: 422,
      code: 'DATESHEET_EMPTY',
    });
    expect(t.update).not.toHaveBeenCalled();
    expect(t.published).not.toHaveBeenCalled();
  });

  it('is 404 when the exam is deactivated between the lookup and the lock', async () => {
    const t = build();
    t.find.mockResolvedValueOnce(exam()).mockResolvedValueOnce(exam({ status: 0 }));
    expect(await refusal(t.service.publish(admin, 'exam-1'))).toMatchObject({ status: 404 });
  });
});
