import { body, problems } from '../../../test/support/dto-validation.js';
import {
  CreateTimetableEntryDto,
  ListTimetableQueryDto,
  UpdateTimetableEntryDto,
} from './timetable-entry.dto.js';

const uuid = '0192f3b0-0000-7000-8000-000000000001';
const lesson = {
  sectionId: uuid,
  dayOfWeek: 1,
  timeSlotId: uuid,
  subjectId: uuid,
  staffMemberId: uuid,
};

describe('CreateTimetableEntryDto', () => {
  it('takes a lesson, and a break', async () => {
    expect(await problems(body(CreateTimetableEntryDto, lesson))).toEqual([]);
    expect(
      await problems(
        body(CreateTimetableEntryDto, {
          sectionId: uuid,
          dayOfWeek: 6,
          timeSlotId: uuid,
          isBreak: true,
        }),
      ),
    ).toEqual([]);
  });

  it.each([
    [{ ...lesson, sectionId: undefined }, 'sectionId', 'REQUIRED'],
    [{ ...lesson, dayOfWeek: 0 }, 'dayOfWeek', 'OUT_OF_RANGE'],
    [{ ...lesson, dayOfWeek: 7 }, 'dayOfWeek', 'OUT_OF_RANGE'],
    [{ ...lesson, dayOfWeek: '1' }, 'dayOfWeek', 'INVALID_TYPE'],
    [{ ...lesson, timeSlotId: 'nope' }, 'timeSlotId', 'INVALID_FORMAT'],
    [{ ...lesson, isBreak: 'yes' }, 'isBreak', 'INVALID_TYPE'],
    [{ ...lesson, subjectId: 'nope' }, 'subjectId', 'INVALID_FORMAT'],
    [{ ...lesson, staffMemberId: 'me' }, 'staffMemberId', 'INVALID_FORMAT'],
    [{ ...lesson, institutionId: uuid }, 'institutionId', 'FIELD_NOT_ALLOWED'],
  ])('refuses %j', async (value, field, code) => {
    expect(await problems(body(CreateTimetableEntryDto, value))).toContainEqual({ field, code });
  });
});

describe('UpdateTimetableEntryDto', () => {
  it('needs the version, and takes any of the five fields', async () => {
    expect(await problems(body(UpdateTimetableEntryDto, { version: 1 }))).toEqual([]);
    expect(
      await problems(
        body(UpdateTimetableEntryDto, {
          version: 2,
          dayOfWeek: 1,
          timeSlotId: uuid,
          subjectId: uuid,
          staffMemberId: uuid,
          isBreak: false,
        }),
      ),
    ).toEqual([]);
    expect(await problems(body(UpdateTimetableEntryDto, { dayOfWeek: 2 }))).toContainEqual({
      field: 'version',
      code: 'REQUIRED',
    });
  });

  it('refuses null (not a UUID), a day out of the week, and the section', async () => {
    expect(
      await problems(body(UpdateTimetableEntryDto, { version: 1, subjectId: null })),
    ).toContainEqual({ field: 'subjectId', code: 'INVALID_FORMAT' });
    expect(
      await problems(body(UpdateTimetableEntryDto, { version: 1, dayOfWeek: 7 })),
    ).toContainEqual({ field: 'dayOfWeek', code: 'OUT_OF_RANGE' });
    expect(
      await problems(body(UpdateTimetableEntryDto, { version: 1, sectionId: uuid })),
    ).toContainEqual({ field: 'sectionId', code: 'FIELD_NOT_ALLOWED' });
  });
});

describe('ListTimetableQueryDto', () => {
  it('takes each selector, a teacher as an ID or `me`', async () => {
    expect(await problems(body(ListTimetableQueryDto, {}))).toEqual([]);
    expect(
      await problems(body(ListTimetableQueryDto, { staffMemberId: 'me', institutionId: uuid })),
    ).toEqual([]);
    expect(await problems(body(ListTimetableQueryDto, { staffMemberId: uuid }))).toEqual([]);
    expect(
      await problems(body(ListTimetableQueryDto, { sectionId: uuid, studentId: uuid })),
    ).toEqual([]);
    expect(await problems(body(ListTimetableQueryDto, { staffMemberId: 'you' }))).toContainEqual({
      field: 'staffMemberId',
      code: 'INVALID_FORMAT',
    });
    expect(await problems(body(ListTimetableQueryDto, { sectionId: 'x' }))).toContainEqual({
      field: 'sectionId',
      code: 'INVALID_FORMAT',
    });
  });
});
