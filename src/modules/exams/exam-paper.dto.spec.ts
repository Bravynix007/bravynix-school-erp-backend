import { body, problems } from '../../../test/support/dto-validation.js';
import {
  CreateExamPaperDto,
  ListExamPapersQueryDto,
  UpdateExamPaperDto,
} from './exam-paper.dto.js';

const uuid = '0192f3b0-0000-7000-8000-000000000001';
const valid = {
  sectionId: uuid,
  subjectId: uuid,
  examDate: '2026-08-10',
  startTime: '09:00',
  endTime: '11:00',
};

describe('CreateExamPaperDto', () => {
  it('takes the required fields, and the optional ones', async () => {
    expect(await problems(body(CreateExamPaperDto, valid))).toEqual([]);
    expect(
      await problems(
        body(CreateExamPaperDto, {
          ...valid,
          roomName: 'Room 12',
          maxMarks: 50,
          passingMarks: 0,
          subjectTeacherStaffMemberId: uuid,
          invigilatorStaffMemberId: uuid,
        }),
      ),
    ).toEqual([]);
    expect(
      await problems(
        body(CreateExamPaperDto, {
          ...valid,
          roomName: null,
          subjectTeacherStaffMemberId: null,
          invigilatorStaffMemberId: null,
        }),
      ),
    ).toEqual([]);
  });

  it.each([
    [{ ...valid, sectionId: undefined }, 'sectionId', 'REQUIRED'],
    [{ ...valid, subjectId: 'nope' }, 'subjectId', 'INVALID_FORMAT'],
    [{ ...valid, examDate: undefined }, 'examDate', 'REQUIRED'],
    [{ ...valid, examDate: '2026-02-30' }, 'examDate', 'INVALID_FORMAT'],
    [{ ...valid, startTime: undefined }, 'startTime', 'REQUIRED'],
    [{ ...valid, startTime: '9:00' }, 'startTime', 'INVALID_FORMAT'],
    [{ ...valid, endTime: '24:00' }, 'endTime', 'INVALID_FORMAT'],
    [{ ...valid, roomName: '   ' }, 'roomName', 'INVALID_FORMAT'],
    [{ ...valid, roomName: 'x'.repeat(51) }, 'roomName', 'TOO_LONG'],
    [{ ...valid, roomName: 12 }, 'roomName', 'INVALID_TYPE'],
    [{ ...valid, maxMarks: 0 }, 'maxMarks', 'OUT_OF_RANGE'],
    [{ ...valid, maxMarks: 1001 }, 'maxMarks', 'OUT_OF_RANGE'],
    [{ ...valid, maxMarks: '50' }, 'maxMarks', 'INVALID_TYPE'],
    [{ ...valid, maxMarks: 50.5 }, 'maxMarks', 'INVALID_TYPE'],
    [{ ...valid, passingMarks: -1 }, 'passingMarks', 'OUT_OF_RANGE'],
    [
      { ...valid, subjectTeacherStaffMemberId: 'nope' },
      'subjectTeacherStaffMemberId',
      'INVALID_FORMAT',
    ],
    [{ ...valid, invigilatorStaffMemberId: 'nope' }, 'invigilatorStaffMemberId', 'INVALID_FORMAT'],
    [{ ...valid, examId: uuid }, 'examId', 'FIELD_NOT_ALLOWED'],
    [{ ...valid, status: 0 }, 'status', 'FIELD_NOT_ALLOWED'],
  ])('refuses %j', async (value, field, code) => {
    expect(await problems(body(CreateExamPaperDto, value))).toContainEqual({ field, code });
  });
});

describe('UpdateExamPaperDto', () => {
  it('needs the version, and takes any of the fields', async () => {
    expect(await problems(body(UpdateExamPaperDto, { version: 1 }))).toEqual([]);
    expect(
      await problems(
        body(UpdateExamPaperDto, {
          version: 2,
          examDate: '2026-08-11',
          startTime: '10:00',
          endTime: '12:00',
          roomName: null,
          maxMarks: 80,
          passingMarks: 30,
          subjectTeacherStaffMemberId: null,
          invigilatorStaffMemberId: uuid,
        }),
      ),
    ).toEqual([]);
  });

  it.each([
    [{}, 'version', 'REQUIRED'],
    [{ version: 1, examDate: null }, 'examDate', 'INVALID_TYPE'],
    [{ version: 1, startTime: null }, 'startTime', 'INVALID_TYPE'],
    [{ version: 1, maxMarks: null }, 'maxMarks', 'INVALID_TYPE'],
    [{ version: 1, maxMarks: 0 }, 'maxMarks', 'OUT_OF_RANGE'],
    [{ version: 1, passingMarks: null }, 'passingMarks', 'INVALID_TYPE'],
    [{ version: 1, roomName: ' ' }, 'roomName', 'INVALID_FORMAT'],
    [{ version: 1, sectionId: uuid }, 'sectionId', 'FIELD_NOT_ALLOWED'],
    [{ version: 1, subjectId: uuid }, 'subjectId', 'FIELD_NOT_ALLOWED'],
    [{ version: 1, examId: uuid }, 'examId', 'FIELD_NOT_ALLOWED'],
  ])('refuses %j', async (value, field, code) => {
    expect(await problems(body(UpdateExamPaperDto, value))).toContainEqual({ field, code });
  });
});

describe('ListExamPapersQueryDto', () => {
  it('takes a section, or a child', async () => {
    expect(await problems(body(ListExamPapersQueryDto, {}))).toEqual([]);
    expect(await problems(body(ListExamPapersQueryDto, { sectionId: uuid }))).toEqual([]);
    expect(await problems(body(ListExamPapersQueryDto, { studentId: uuid }))).toEqual([]);
  });

  it('refuses a UUID that is not one', async () => {
    expect(await problems(body(ListExamPapersQueryDto, { sectionId: 'x' }))).toContainEqual({
      field: 'sectionId',
      code: 'INVALID_FORMAT',
    });
  });
});
