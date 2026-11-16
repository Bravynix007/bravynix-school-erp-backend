import { body, problems } from '../../../test/support/dto-validation.js';
import {
  ChangeEventScopeDto,
  CreateEventDto,
  ListEventsQueryDto,
  UpdateEventDto,
} from './event.dto.js';

const uuid = '0192f3b0-0000-7000-8000-000000000001';
const valid = {
  title: 'Annual Day',
  startDate: '2026-12-22',
  endDate: '2026-12-24',
  durationLabel: '3 Days',
  scope: 2,
  institutionId: uuid,
};

describe('CreateEventDto', () => {
  it('takes the required fields and every optional one', async () => {
    expect(await problems(body(CreateEventDto, valid))).toEqual([]);
    expect(
      await problems(
        body(CreateEventDto, {
          ...valid,
          description: null,
          venue: 'Hall',
          audience: 3,
          presetImageCode: 'sports',
          isHoliday: true,
          holidayType: 4,
          holidayForStudents: true,
          holidayForStaff: false,
          holidayPredefinedClassIds: [uuid],
        }),
      ),
    ).toEqual([]);
  });

  it.each([
    [{ ...valid, title: undefined }, 'title', 'INVALID_TYPE'],
    [{ ...valid, title: '  ' }, 'title', 'INVALID_FORMAT'],
    [{ ...valid, title: 'x'.repeat(151) }, 'title', 'TOO_LONG'],
    [{ ...valid, startDate: '22/12/2026' }, 'startDate', 'INVALID_FORMAT'],
    [{ ...valid, endDate: '2026-02-30' }, 'endDate', 'INVALID_FORMAT'],
    [{ ...valid, durationLabel: '' }, 'durationLabel', 'TOO_SHORT'],
    [{ ...valid, durationLabel: 'x'.repeat(51) }, 'durationLabel', 'TOO_LONG'],
    [{ ...valid, description: 'x'.repeat(2001) }, 'description', 'TOO_LONG'],
    [{ ...valid, venue: 'x'.repeat(201) }, 'venue', 'TOO_LONG'],
    [{ ...valid, audience: 4 }, 'audience', 'INVALID_CODE'],
    [{ ...valid, audience: '1' }, 'audience', 'INVALID_TYPE'],
    [{ ...valid, scope: 3 }, 'scope', 'INVALID_CODE'],
    [{ ...valid, scope: undefined }, 'scope', 'INVALID_TYPE'],
    [{ ...valid, institutionId: 'nope' }, 'institutionId', 'INVALID_FORMAT'],
    [{ ...valid, presetImageCode: 'unicorn' }, 'presetImageCode', 'INVALID_CODE'],
    [{ ...valid, isHoliday: 'yes' }, 'isHoliday', 'INVALID_TYPE'],
    [{ ...valid, holidayType: 5 }, 'holidayType', 'INVALID_CODE'],
    [{ ...valid, holidayType: '1' }, 'holidayType', 'INVALID_TYPE'],
    [{ ...valid, holidayForStudents: 1 }, 'holidayForStudents', 'INVALID_TYPE'],
    [{ ...valid, holidayPredefinedClassIds: 'a' }, 'holidayPredefinedClassIds', 'INVALID_TYPE'],
    [
      { ...valid, holidayPredefinedClassIds: ['nope'] },
      'holidayPredefinedClassIds',
      'INVALID_FORMAT',
    ],
    [
      { ...valid, holidayPredefinedClassIds: Array.from({ length: 41 }, () => uuid) },
      'holidayPredefinedClassIds',
      'TOO_MANY',
    ],
    [{ ...valid, societyId: uuid }, 'societyId', 'FIELD_NOT_ALLOWED'],
    [{ ...valid, status: 0 }, 'status', 'FIELD_NOT_ALLOWED'],
  ])('refuses %j', async (value, field, code) => {
    expect(await problems(body(CreateEventDto, value))).toContainEqual({ field, code });
  });

  it('reads an upper-case ID in lower case', async () => {
    const parsed = await body(CreateEventDto, {
      ...valid,
      institutionId: uuid.toUpperCase(),
      holidayPredefinedClassIds: [uuid.toUpperCase()],
    });
    expect(parsed.institutionId).toBe(uuid);
    expect(parsed.holidayPredefinedClassIds).toEqual([uuid]);
  });
});

describe('UpdateEventDto', () => {
  it('needs the version as a whole number, and takes any field', async () => {
    expect(await problems(body(UpdateEventDto, { version: 1 }))).toEqual([]);
    expect(
      await problems(
        body(UpdateEventDto, {
          version: 2,
          title: 'x',
          venue: null,
          holidayType: null,
          presetImageCode: null,
        }),
      ),
    ).toEqual([]);
    expect(await problems(body(UpdateEventDto, { title: 'x' }))).toContainEqual({
      field: 'version',
      code: 'INVALID_TYPE',
    });
    expect(await problems(body(UpdateEventDto, { version: '1' }))).toContainEqual({
      field: 'version',
      code: 'INVALID_TYPE',
    });
  });

  it('refuses null for a field that cannot be cleared, and the fields that are not editable', async () => {
    for (const field of [
      'title',
      'startDate',
      'endDate',
      'durationLabel',
      'audience',
      'isHoliday',
      'holidayForStudents',
      'holidayForStaff',
      'holidayPredefinedClassIds',
    ]) {
      expect(await problems(body(UpdateEventDto, { version: 1, [field]: null }))).toContainEqual({
        field,
        code: 'INVALID_TYPE',
      });
    }
    for (const field of ['scope', 'institutionId', 'status']) {
      expect(await problems(body(UpdateEventDto, { version: 1, [field]: 1 }))).toContainEqual({
        field,
        code: 'FIELD_NOT_ALLOWED',
      });
    }
  });
});

describe('ChangeEventScopeDto', () => {
  it('needs the version and a scope, and takes the Institution', async () => {
    expect(await problems(body(ChangeEventScopeDto, { version: 1, scope: 1 }))).toEqual([]);
    expect(
      await problems(body(ChangeEventScopeDto, { version: 1, scope: 2, institutionId: uuid })),
    ).toEqual([]);
    expect(await problems(body(ChangeEventScopeDto, { version: 1 }))).toContainEqual({
      field: 'scope',
      code: 'INVALID_TYPE',
    });
    expect(await problems(body(ChangeEventScopeDto, { version: 1, scope: 0 }))).toContainEqual({
      field: 'scope',
      code: 'INVALID_CODE',
    });
  });
});

describe('ListEventsQueryDto', () => {
  it('takes dates, an academic year, an Institution and the holidays flag, all optional', async () => {
    expect(await problems(body(ListEventsQueryDto, {}))).toEqual([]);
    const parsed = await body(ListEventsQueryDto, {
      from: '2026-12-01',
      to: '2026-12-31',
      academicYearId: uuid.toUpperCase(),
      institutionId: uuid,
      holidays: 'true',
    });
    expect(parsed).toMatchObject({ academicYearId: uuid, holidays: true });
  });

  it.each([
    [{ from: '1/12/2026' }, 'from', 'INVALID_FORMAT'],
    [{ to: '2026-13-01' }, 'to', 'INVALID_FORMAT'],
    [{ academicYearId: 'nope' }, 'academicYearId', 'INVALID_FORMAT'],
    [{ institutionId: 'nope' }, 'institutionId', 'INVALID_FORMAT'],
    [{ holidays: 'maybe' }, 'holidays', 'INVALID_TYPE'],
  ])('refuses %j', async (value, field, code) => {
    expect(await problems(body(ListEventsQueryDto, value))).toContainEqual({ field, code });
  });
});
