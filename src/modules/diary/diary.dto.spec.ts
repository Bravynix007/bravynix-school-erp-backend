import { body, problems } from '../../../test/support/dto-validation.js';
import { CreateDiaryEntryDto, ListDiaryQueryDto, UpdateDiaryEntryDto } from './diary.dto.js';

const uuid = '0192f3b0-0000-7000-8000-000000000001';
const entry = {
  sectionId: uuid,
  subjectId: uuid,
  diaryDate: '2026-11-17',
  description: 'Exercise 4.2',
};

describe('ListDiaryQueryDto', () => {
  it('takes a date with a section or a child', async () => {
    expect(
      await problems(body(ListDiaryQueryDto, { sectionId: uuid, date: '2026-11-17' })),
    ).toEqual([]);
    expect(
      await problems(body(ListDiaryQueryDto, { studentId: uuid, date: '2026-11-17' })),
    ).toEqual([]);
  });

  it('refuses a made-up date or ID, and a missing date', async () => {
    expect(
      await problems(body(ListDiaryQueryDto, { sectionId: 'nope', date: '2026-02-30' })),
    ).toEqual([
      { field: 'sectionId', code: 'INVALID_FORMAT' },
      { field: 'date', code: 'INVALID_FORMAT' },
    ]);
    expect(await problems(body(ListDiaryQueryDto, { sectionId: uuid }))).toEqual([
      { field: 'date', code: 'INVALID_TYPE' },
    ]);
  });
});

describe('CreateDiaryEntryDto', () => {
  it('takes a section, a subject, a day and a description', async () => {
    expect(await problems(body(CreateDiaryEntryDto, entry))).toEqual([]);
    expect(
      await problems(body(CreateDiaryEntryDto, { ...entry, description: 'x'.repeat(2000) })),
    ).toEqual([]);
  });

  it('refuses a description that is empty, blank or too long', async () => {
    expect(await problems(body(CreateDiaryEntryDto, { ...entry, description: '' }))).toEqual([
      { field: 'description', code: 'TOO_SHORT' },
    ]);
    expect(
      await problems(body(CreateDiaryEntryDto, { ...entry, description: 'x'.repeat(2001) })),
    ).toEqual([{ field: 'description', code: 'TOO_LONG' }]);
  });

  it('refuses the wrong shapes and names each field', async () => {
    expect(
      await problems(
        body(CreateDiaryEntryDto, { sectionId: 'a', subjectId: 5, diaryDate: '2026-13-01' }),
      ),
    ).toEqual([
      { field: 'sectionId', code: 'INVALID_FORMAT' },
      { field: 'subjectId', code: 'INVALID_FORMAT' },
      { field: 'diaryDate', code: 'INVALID_FORMAT' },
      { field: 'description', code: 'INVALID_TYPE' },
    ]);
  });
});

describe('UpdateDiaryEntryDto', () => {
  it('takes a version alone, or with any of the three fields', async () => {
    expect(await problems(body(UpdateDiaryEntryDto, { version: 1 }))).toEqual([]);
    expect(
      await problems(
        body(UpdateDiaryEntryDto, {
          version: 2,
          subjectId: uuid,
          diaryDate: '2026-11-16',
          description: 'Redo.',
        }),
      ),
    ).toEqual([]);
  });

  it('needs the version, and refuses a field named null or in the wrong shape', async () => {
    expect(await problems(body(UpdateDiaryEntryDto, { description: 'x' }))).toEqual([
      { field: 'version', code: 'INVALID_TYPE' },
    ]);
    expect(
      await problems(
        body(UpdateDiaryEntryDto, {
          version: 1,
          subjectId: null,
          diaryDate: '2026-02-30',
          description: '',
        }),
      ),
    ).toEqual([
      { field: 'subjectId', code: 'INVALID_FORMAT' },
      { field: 'diaryDate', code: 'INVALID_FORMAT' },
      { field: 'description', code: 'TOO_SHORT' },
    ]);
  });
});
