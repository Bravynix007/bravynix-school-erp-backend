import { AppException } from '../../common/http/app-exception.js';
import {
  marksOf,
  requireExamDate,
  requirePassingMarks,
  translatePaperError,
} from './exam-paper.rules.js';

const exam = { startDate: '2026-08-10', endDate: '2026-08-14' };

function refusal(run: () => unknown): AppException {
  try {
    run();
  } catch (error) {
    return error as AppException;
  }
  throw new Error('Expected a refusal');
}

describe('requireExamDate', () => {
  it.each(['2026-08-10', '2026-08-12', '2026-08-14'])('lets %s through', (day) => {
    expect(() => requireExamDate(day, exam)).not.toThrow();
  });

  it.each(['2026-08-09', '2026-08-15', '2027-08-12'])(
    'refuses %s as 400 OUT_OF_RANGE on examDate',
    (day) => {
      const error = refusal(() => requireExamDate(day, exam));
      expect(error.status).toBe(400);
      expect(error.options.errors?.map((e) => [e.field, e.code])).toEqual([
        ['examDate', 'OUT_OF_RANGE'],
      ]);
    },
  );
});

describe('requirePassingMarks', () => {
  it('lets the passing marks be anything up to the maximum', () => {
    expect(() => requirePassingMarks(100, 0)).not.toThrow();
    expect(() => requirePassingMarks(100, 100)).not.toThrow();
  });

  it('refuses passing marks above the maximum as 400 OUT_OF_RANGE on passingMarks', () => {
    const error = refusal(() => requirePassingMarks(20, 21));
    expect(error.status).toBe(400);
    expect(error.options.errors?.map((e) => [e.field, e.code])).toEqual([
      ['passingMarks', 'OUT_OF_RANGE'],
    ]);
  });
});

describe('marksOf', () => {
  it('defaults to 100 and 35', () => {
    expect(marksOf(undefined, undefined)).toEqual({ maxMarks: 100, passingMarks: 35 });
  });

  it('keeps what the request names', () => {
    expect(marksOf(50, 20)).toEqual({ maxMarks: 50, passingMarks: 20 });
    expect(marksOf(undefined, 40)).toEqual({ maxMarks: 100, passingMarks: 40 });
  });

  it('never defaults the passing marks above a lower maximum', () => {
    expect(marksOf(20, undefined)).toEqual({ maxMarks: 20, passingMarks: 20 });
    expect(marksOf(35, undefined)).toEqual({ maxMarks: 35, passingMarks: 35 });
    expect(marksOf(1000, undefined)).toEqual({ maxMarks: 1000, passingMarks: 35 });
  });
});

describe('translatePaperError', () => {
  it('turns a subject already set for the section into DUPLICATE on subjectId', () => {
    const error = translatePaperError({
      code: '23505',
      constraint: 'uq_exam_papers_exam_section_subject',
    }) as AppException;
    expect(error.status).toBe(409);
    expect(error.code).toBe('DUPLICATE');
    expect(error.options.errors?.[0]).toMatchObject({ field: 'subjectId' });
  });

  it.each([
    ['ex_exam_papers_section_time', 'PAPER_OVERLAP', 'startTime'],
    ['ex_exam_papers_invigilator_time', 'INVIGILATOR_DOUBLE_BOOKED', 'invigilatorStaffMemberId'],
    ['ex_exam_papers_room_time', 'ROOM_TAKEN', 'roomName'],
  ])('turns an overlap on %s into 409 %s on %s', (constraint, code, field) => {
    const error = translatePaperError({ code: '23P01', constraint }) as AppException;
    expect(error.status).toBe(409);
    expect(error.code).toBe(code);
    expect(error.options.errors?.[0]).toMatchObject({ field, code });
  });

  it('leaves any other error as it is', () => {
    const other = new Error('boom');
    expect(translatePaperError(other)).toBe(other);
    const unique = { code: '23505', constraint: 'other' };
    expect(translatePaperError(unique)).toBe(unique);
    const exclusion = { code: '23P01', constraint: 'ex_time_slots_no_overlap' };
    expect(translatePaperError(exclusion)).toBe(exclusion);
  });
});
