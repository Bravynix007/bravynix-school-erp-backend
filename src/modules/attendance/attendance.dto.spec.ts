import { body, problems } from '../../../test/support/dto-validation.js';
import { ListSessionsQueryDto, RosterQueryDto, SubmitAttendanceDto } from './attendance.dto.js';

const uuid = '0192f3b0-0000-7000-8000-000000000001';
const submission = {
  sectionId: uuid,
  attendanceDate: '2026-10-23',
  rosterCount: 32,
  exceptions: [{ studentEnrolmentId: uuid, attendanceStatus: 2 }],
};

describe('RosterQueryDto', () => {
  it('takes a section and a real date', async () => {
    expect(await problems(body(RosterQueryDto, { sectionId: uuid, date: '2026-10-23' }))).toEqual(
      [],
    );
    expect(await problems(body(RosterQueryDto, { sectionId: 'nope', date: '2026-02-30' }))).toEqual(
      [
        { field: 'sectionId', code: 'INVALID_FORMAT' },
        { field: 'date', code: 'INVALID_FORMAT' },
      ],
    );
  });
});

describe('ListSessionsQueryDto', () => {
  it('needs the date, and takes a section or an Institution', async () => {
    expect(await problems(body(ListSessionsQueryDto, { date: '2026-10-23' }))).toEqual([]);
    expect(
      await problems(body(ListSessionsQueryDto, { date: '2026-10-23', sectionId: uuid })),
    ).toEqual([]);
    expect(await problems(body(ListSessionsQueryDto, { institutionId: uuid }))).toContainEqual({
      field: 'date',
      code: 'INVALID_TYPE',
    });
  });
});

describe('SubmitAttendanceDto', () => {
  it('takes a submission with marks, and with none', async () => {
    expect(await problems(body(SubmitAttendanceDto, submission))).toEqual([]);
    expect(await problems(body(SubmitAttendanceDto, { ...submission, exceptions: [] }))).toEqual(
      [],
    );
  });

  it.each([
    [{ ...submission, sectionId: undefined }, 'sectionId', 'INVALID_FORMAT'],
    [{ ...submission, attendanceDate: '23-10-2026' }, 'attendanceDate', 'INVALID_FORMAT'],
    [{ ...submission, rosterCount: '32' }, 'rosterCount', 'INVALID_TYPE'],
    [{ ...submission, rosterCount: -1 }, 'rosterCount', 'OUT_OF_RANGE'],
    [{ ...submission, rosterCount: 1001 }, 'rosterCount', 'OUT_OF_RANGE'],
    [{ ...submission, exceptions: undefined }, 'exceptions', 'INVALID_TYPE'],
    [
      { ...submission, exceptions: [{ studentEnrolmentId: uuid, attendanceStatus: 1 }] },
      'exceptions[0].attendanceStatus',
      'INVALID_CODE',
    ],
    [
      { ...submission, exceptions: [{ studentEnrolmentId: uuid, attendanceStatus: 6 }] },
      'exceptions[0].attendanceStatus',
      'INVALID_CODE',
    ],
    [
      { ...submission, exceptions: [{ studentEnrolmentId: 'x', attendanceStatus: 2 }] },
      'exceptions[0].studentEnrolmentId',
      'INVALID_FORMAT',
    ],
    [{ ...submission, timeSlotId: uuid }, 'timeSlotId', 'FIELD_NOT_ALLOWED'],
  ])('refuses %j', async (value, field, code) => {
    expect(await problems(body(SubmitAttendanceDto, value))).toContainEqual({ field, code });
  });
});
