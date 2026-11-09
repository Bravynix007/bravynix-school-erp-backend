import { body, problems } from '../../../test/support/dto-validation.js';
import { createValidationPipe } from '../../common/validation/validation.js';
import {
  CreateTeachingAssignmentDto,
  ListTeachingAssignmentsQueryDto,
  SetClassTeacherDto,
} from './assignment.dto.js';

const id = (n: number) => `0192f3b0-0000-7000-8000-00000000000${String(n)}`;

describe('SetClassTeacherDto', () => {
  it('takes a year and a section, in either case, or null to end', async () => {
    expect(
      await problems(body(SetClassTeacherDto, { academicYearId: id(1), sectionId: id(2) })),
    ).toEqual([]);
    expect(
      await problems(body(SetClassTeacherDto, { academicYearId: id(1), sectionId: null })),
    ).toEqual([]);
    const upper = await body(SetClassTeacherDto, {
      academicYearId: id(1).toUpperCase(),
      sectionId: id(2).toUpperCase(),
    });
    expect([upper.academicYearId, upper.sectionId]).toEqual([id(1), id(2)]);
  });

  it.each([
    ['no year', { sectionId: id(2) }, [{ field: 'academicYearId', code: 'INVALID_FORMAT' }]],
    [
      'no section: null is the way to end it',
      { academicYearId: id(1) },
      [{ field: 'sectionId', code: 'INVALID_FORMAT' }],
    ],
    [
      'a word for the section',
      { academicYearId: id(1), sectionId: 'x' },
      [{ field: 'sectionId', code: 'INVALID_FORMAT' }],
    ],
    [
      'a field that is not allowed',
      { academicYearId: id(1), sectionId: null, status: 1 },
      [{ field: 'status', code: 'FIELD_NOT_ALLOWED' }],
    ],
  ])('refuses %s', async (_name, value, expected) => {
    expect(await problems(body(SetClassTeacherDto, value))).toEqual(expected);
  });
});

describe('CreateTeachingAssignmentDto', () => {
  const full = {
    staffMemberId: id(1),
    academicYearId: id(2),
    sectionId: id(3),
    subjectId: id(4),
  };

  it('takes the four IDs', async () => {
    expect(await problems(body(CreateTeachingAssignmentDto, full))).toEqual([]);
  });

  it.each(['staffMemberId', 'academicYearId', 'sectionId', 'subjectId'])(
    'refuses a request without %s',
    async (field) => {
      const { [field]: _left, ...rest } = full as Record<string, string>;
      expect(await problems(body(CreateTeachingAssignmentDto, rest))).toEqual([
        { field, code: 'INVALID_FORMAT' },
      ]);
    },
  );

  it('refuses a field that is not allowed', async () => {
    expect(await problems(body(CreateTeachingAssignmentDto, { ...full, endedAt: 'x' }))).toEqual([
      { field: 'endedAt', code: 'FIELD_NOT_ALLOWED' },
    ]);
  });
});

describe('ListTeachingAssignmentsQueryDto', () => {
  const pipe = createValidationPipe();
  const query = (value: unknown) =>
    pipe.transform(value, {
      type: 'query',
      metatype: ListTeachingAssignmentsQueryDto,
    }) as Promise<ListTeachingAssignmentsQueryDto>;

  it('needs an Institution, and takes the filters and a page, with the defaults', async () => {
    expect(await query({ institutionId: id(1) })).toMatchObject({
      institutionId: id(1),
      page: 1,
      limit: 20,
    });
    expect(
      await query({
        institutionId: id(1),
        academicYearId: id(2),
        sectionId: id(3),
        subjectId: id(4),
        staffMemberId: id(5),
        page: '2',
        limit: '5',
      }),
    ).toMatchObject({ academicYearId: id(2), staffMemberId: id(5), page: 2, limit: 5 });
  });

  it('refuses a missing or malformed Institution, a malformed filter, and a search or a sort', async () => {
    for (const value of [
      {},
      { institutionId: 'x' },
      { institutionId: id(1), sectionId: 'x' },
      { institutionId: id(1), q: 'asha' },
      { institutionId: id(1), sort: 'name' },
    ]) {
      await expect(query(value)).rejects.toMatchObject({ status: 400 });
    }
  });
});
