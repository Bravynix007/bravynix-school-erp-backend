import { body, problems } from '../../../test/support/dto-validation.js';
import { CreateTimeSlotDto, ListTimeSlotsQueryDto, UpdateTimeSlotDto } from './time-slot.dto.js';

const uuid = '0192f3b0-0000-7000-8000-000000000001';
const valid = { institutionId: uuid, periodNo: 3, startTime: '09:40', endTime: '10:20' };

describe('CreateTimeSlotDto', () => {
  it('takes the required fields, and the optional ones', async () => {
    expect(await problems(body(CreateTimeSlotDto, valid))).toEqual([]);
    expect(
      await problems(
        body(CreateTimeSlotDto, {
          ...valid,
          academicYearId: uuid,
          label: 'Period 3',
          isBreak: false,
        }),
      ),
    ).toEqual([]);
    expect(await problems(body(CreateTimeSlotDto, { ...valid, label: null }))).toEqual([]);
  });

  it.each([
    [{ ...valid, institutionId: undefined }, 'institutionId', 'INVALID_FORMAT'],
    [{ ...valid, academicYearId: 'nope' }, 'academicYearId', 'INVALID_FORMAT'],
    [{ ...valid, periodNo: 0 }, 'periodNo', 'OUT_OF_RANGE'],
    [{ ...valid, periodNo: 31 }, 'periodNo', 'OUT_OF_RANGE'],
    [{ ...valid, periodNo: '3' }, 'periodNo', 'INVALID_TYPE'],
    [{ ...valid, periodNo: 2.5 }, 'periodNo', 'INVALID_TYPE'],
    [{ ...valid, label: '' }, 'label', 'TOO_SHORT'],
    [{ ...valid, label: '   ' }, 'label', 'INVALID_FORMAT'],
    [{ ...valid, label: 'x'.repeat(101) }, 'label', 'TOO_LONG'],
    [{ ...valid, startTime: '9:40' }, 'startTime', 'INVALID_FORMAT'],
    [{ ...valid, startTime: '24:00' }, 'startTime', 'INVALID_FORMAT'],
    [{ ...valid, endTime: '10:60' }, 'endTime', 'INVALID_FORMAT'],
    [{ ...valid, endTime: undefined }, 'endTime', 'INVALID_TYPE'],
    [{ ...valid, isBreak: 'yes' }, 'isBreak', 'INVALID_TYPE'],
    [{ ...valid, societyId: uuid }, 'societyId', 'FIELD_NOT_ALLOWED'],
  ])('refuses %j', async (value, field, code) => {
    expect(await problems(body(CreateTimeSlotDto, value))).toContainEqual({ field, code });
  });
});

describe('UpdateTimeSlotDto', () => {
  it('needs the version, and takes any of the label and the two times', async () => {
    expect(await problems(body(UpdateTimeSlotDto, { version: 1 }))).toEqual([]);
    expect(
      await problems(
        body(UpdateTimeSlotDto, { version: 2, label: null, startTime: '09:00', endTime: '09:40' }),
      ),
    ).toEqual([]);
    expect(await problems(body(UpdateTimeSlotDto, { label: 'x' }))).toContainEqual({
      field: 'version',
      code: 'INVALID_TYPE',
    });
  });

  it('refuses null for a time, and the fields that are not editable', async () => {
    expect(await problems(body(UpdateTimeSlotDto, { version: 1, startTime: null }))).toContainEqual(
      { field: 'startTime', code: 'INVALID_TYPE' },
    );
    expect(await problems(body(UpdateTimeSlotDto, { version: 1, endTime: '9am' }))).toContainEqual({
      field: 'endTime',
      code: 'INVALID_FORMAT',
    });
    for (const field of ['periodNo', 'isBreak', 'academicYearId', 'institutionId']) {
      expect(await problems(body(UpdateTimeSlotDto, { version: 1, [field]: 1 }))).toContainEqual({
        field,
        code: 'FIELD_NOT_ALLOWED',
      });
    }
  });
});

describe('ListTimeSlotsQueryDto', () => {
  it('takes the three ids, each optional', async () => {
    expect(await problems(body(ListTimeSlotsQueryDto, {}))).toEqual([]);
    expect(
      await problems(
        body(ListTimeSlotsQueryDto, { institutionId: uuid, academicYearId: uuid, studentId: uuid }),
      ),
    ).toEqual([]);
    expect(await problems(body(ListTimeSlotsQueryDto, { studentId: 'x' }))).toContainEqual({
      field: 'studentId',
      code: 'INVALID_FORMAT',
    });
  });
});
