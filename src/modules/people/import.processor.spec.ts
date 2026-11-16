import { AppException } from '../../common/http/app-exception.js';
import type { Clock } from '../../common/time/clock.js';
import type { AuditService } from '../../platform/audit/index.js';
import type { DatabaseService } from '../../platform/database/index.js';
import type { FileDirectory } from '../../platform/files/index.js';
import {
  JobLeaseLost,
  type ClaimedJob,
  type JobLease,
  type JobRegistry,
} from '../../platform/jobs/index.js';
import type { SectionDirectory } from '../academic-setup/index.js';
import { IMPORT_HEADER } from './import.csv.js';
import { ImportProcessor, rowProblem } from './import.processor.js';
import type { ImportRepository, ImportRunRow } from './import.repository.js';
import { RunStatus } from './import.rules.js';
import type { StudentService } from './student.service.js';

const conflict = (code: string) => AppException.conflict(code);
const duplicateOn = (constraint: string) =>
  Object.assign(new Error('duplicate'), { code: '23505', constraint });

describe('rowProblem', () => {
  it('says a roll number that is taken in the section', () => {
    expect(rowProblem(duplicateOn('uq_placements_roll'))).toBe(
      'RollNumber is already used in this section',
    );
  });

  it.each(['ROLE_CONFLICT', 'ACCOUNT_BLOCKED', 'INVALID_STATE', 'EMAIL_IN_USE'])(
    'says a guardian email that cannot be linked for %s, without repeating the email',
    (code) => {
      expect(rowProblem(conflict(code))).toMatch(
        /^GuardianEmail belongs to an account that cannot/,
      );
    },
  );

  it('says a year or a section that closed while the import ran', () => {
    expect(rowProblem(AppException.businessRule('YEAR_NOT_ACTIVE'))).toBeTruthy();
    expect(rowProblem(AppException.businessRule('INACTIVE_SECTION'))).toBeTruthy();
  });

  it.each([
    ['a lost connection', Object.assign(new Error('terminated'), { code: '57P01' })],
    ['another unique violation', duplicateOn('uq_students_institution_admission_no')],
    ['a refusal that is not about the row', AppException.notFound()],
    ['something that is not an error', 'nope'],
  ])(
    'is not a problem of the row for %s, so the batch stops and the job tries again',
    (_name, error) => {
      expect(rowProblem(error)).toBeNull();
    },
  );
});

const RUN = '11111111-1111-4111-8111-111111111111';
const job: ClaimedJob = {
  id: 'job-1',
  kind: 'students.import',
  societyId: 'society-1',
  institutionId: 'institution-1',
  startedBy: 'person-1',
  payload: { importRunId: RUN, roleCode: 2 },
  attempts: 1,
};
const lease: JobLease = { keep: () => Promise.resolve() };
const row = (changes: Partial<ImportRunRow>) =>
  ({
    id: RUN,
    file_id: 'file-1',
    academic_year_id: 'year-1',
    run_status: RunStatus.Running,
    processed_rows: 0,
    imported_rows: 0,
    skipped_rows: 0,
    row_errors: [],
    over_capacity: false,
    ...changes,
  }) as ImportRunRow;

function build(found: ImportRunRow, locked: ImportRunRow = found) {
  const runs = {
    find: vi.fn<ImportRepository['find']>().mockResolvedValue(found),
    findForUpdate: vi.fn<ImportRepository['findForUpdate']>().mockResolvedValue(locked),
    start: vi.fn<ImportRepository['start']>(),
    settle: vi.fn<ImportRepository['settle']>(),
    fail: vi.fn<ImportRepository['fail']>(),
  };
  const files = {
    contentOf: vi
      .fn<FileDirectory['contentOf']>()
      .mockResolvedValue(
        Buffer.from(`${IMPORT_HEADER.join(',')}\r\nAsha Rao,1,9th,A,Meera Rao,9876500001,\r\n`),
      ),
  };
  const students = {
    addWithin: vi.fn<StudentService['addWithin']>(),
    welcome: vi.fn<StudentService['welcome']>(),
  };
  const sections = { openOf: vi.fn<SectionDirectory['openOf']>().mockResolvedValue([]) };
  const database = {
    transaction: vi.fn<(tenant: unknown, work: (tx: object) => unknown) => unknown>(
      (_tenant, work) => work({}),
    ),
  };
  const processor = new ImportProcessor(
    database as unknown as DatabaseService,
    runs as unknown as ImportRepository,
    students as unknown as StudentService,
    files as unknown as FileDirectory,
    sections as unknown as SectionDirectory,
    { record: vi.fn<AuditService['record']>() } as unknown as AuditService,
    { register: vi.fn<JobRegistry['register']>() } as unknown as JobRegistry,
    { now: () => new Date('2026-11-16T04:30:00.000Z') } as unknown as Clock,
  );
  return { processor, runs, files, students, sections };
}

describe('ImportProcessor.run', () => {
  it.each([RunStatus.Completed, RunStatus.Failed])(
    'does nothing for a run that is settled already (status %i): nobody is added, nothing is saved',
    async (runStatus) => {
      const { processor, runs, files, students } = build(row({ run_status: runStatus }));
      await expect(processor.run(job, lease)).resolves.toBeUndefined();
      expect(files.contentOf).not.toHaveBeenCalled();
      expect(students.addWithin).not.toHaveBeenCalled();
      expect(runs.settle).not.toHaveBeenCalled();
      expect(runs.start).not.toHaveBeenCalled();
    },
  );

  it('throws JobLeaseLost and saves nothing when the run moved on after the lease was kept', async () => {
    // The worker read the run at 0 rows; by the time its batch locks the run, another worker has saved 100.
    const { processor, runs, students, sections } = build(
      row({ processed_rows: 0 }),
      row({ processed_rows: 100 }),
    );
    await expect(processor.run(job, lease)).rejects.toBeInstanceOf(JobLeaseLost);
    expect(sections.openOf).not.toHaveBeenCalled();
    expect(students.addWithin).not.toHaveBeenCalled();
    expect(runs.settle).not.toHaveBeenCalled();
  });

  it('throws JobLeaseLost when the run was settled after the lease was kept', async () => {
    const { processor, runs } = build(row({}), row({ run_status: RunStatus.Completed }));
    await expect(processor.run(job, lease)).rejects.toBeInstanceOf(JobLeaseLost);
    expect(runs.settle).not.toHaveBeenCalled();
  });
});
