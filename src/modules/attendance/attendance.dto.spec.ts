import { body, problems } from '../../../test/support/dto-validation.js';
import {
  AttendanceSectionsQueryDto,
  CorrectAttendanceDto,
  ListSessionsQueryDto,
  RosterQueryDto,
  SubmitAttendanceDto,
} from './attendance.dto.js';

const uuid = '0192f3b0-0000-7000-8000-000000000001';
const submission = {
  sectionId: uuid,
  attendanceDate: '2026-10-23',
  rosterCount: 32,
  exceptions: [{ studentEnrolmentId: uuid, attendanceStatus: 2 }],
};

describe('AttendanceSectionsQueryDto', () => {
  it('takes an Institution and nothing less', async () => {
    expect(await problems(body(AttendanceSectionsQueryDto, { institutionId: uuid }))).toEqual([]);
    expect(await problems(body(AttendanceSectionsQueryDto, {}))).toEqual([
      { field: 'institutionId', code: 'INVALID_FORMAT' },
    ]);
    expect(await problems(body(AttendanceSectionsQueryDto, { institutionId: 'nope' }))).toEqual([
      { field: 'institutionId', code: 'INVALID_FORMAT' },
    ]);
  });
});

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

describe('CorrectAttendanceDto', () => {
  const correction = {
    version: 1,
    changes: [{ studentEnrolmentId: uuid, attendanceStatus: 1 }],
  };

  it('takes Present as well as the four exceptions', async () => {
    expect(await problems(body(CorrectAttendanceDto, correction))).toEqual([]);
    for (const attendanceStatus of [2, 3, 4, 5]) {
      expect(
        await problems(
          body(CorrectAttendanceDto, {
            ...correction,
            changes: [{ studentEnrolmentId: uuid, attendanceStatus }],
          }),
        ),
      ).toEqual([]);
    }
  });

  it('needs a version and one to 200 changes, each a student and a status 1 to 5', async () => {
    expect(await problems(body(CorrectAttendanceDto, { changes: correction.changes }))).toEqual([
      { field: 'version', code: 'INVALID_TYPE' },
    ]);
    expect(await problems(body(CorrectAttendanceDto, { ...correction, changes: [] }))).toEqual([
      { field: 'changes', code: 'TOO_FEW' },
    ]);
    expect(
      await problems(
        body(CorrectAttendanceDto, {
          ...correction,
          changes: Array.from({ length: 201 }, () => correction.changes[0]),
        }),
      ),
    ).toEqual([{ field: 'changes', code: 'TOO_MANY' }]);
    expect(
      await problems(
        body(CorrectAttendanceDto, {
          ...correction,
          changes: [{ studentEnrolmentId: 'x', attendanceStatus: 6 }],
        }),
      ),
    ).toEqual([
      { field: 'changes[0].studentEnrolmentId', code: 'INVALID_FORMAT' },
      { field: 'changes[0].attendanceStatus', code: 'INVALID_CODE' },
    ]);
  });
});
