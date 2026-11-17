import { AppException } from '../../common/http/app-exception.js';
import {
  entryShapeErrors,
  requireEntryShape,
  requireUsableSlot,
  translateEntryError,
} from './timetable-entry.rules.js';

function refusal(run: () => unknown): AppException {
  try {
    run();
  } catch (error) {
    return error as AppException;
  }
  throw new Error('Expected a refusal');
}

describe('entryShapeErrors', () => {
  it('asks a lesson for its subject and its teacher', () => {
    expect(entryShapeErrors({ isBreak: false, subjectId: null, staffMemberId: null })).toEqual([
      expect.objectContaining({ field: 'subjectId', code: 'REQUIRED' }),
      expect.objectContaining({ field: 'staffMemberId', code: 'REQUIRED' }),
    ]);
    expect(entryShapeErrors({ isBreak: false, subjectId: 's', staffMemberId: null })).toEqual([
      expect.objectContaining({ field: 'staffMemberId', code: 'REQUIRED' }),
    ]);
    expect(entryShapeErrors({ isBreak: false, subjectId: 's', staffMemberId: 't' })).toEqual([]);
  });

  it('allows a break neither', () => {
    expect(entryShapeErrors({ isBreak: true, subjectId: null, staffMemberId: null })).toEqual([]);
    expect(entryShapeErrors({ isBreak: true, subjectId: 's', staffMemberId: 't' })).toEqual([
      expect.objectContaining({ field: 'subjectId', code: 'FIELD_NOT_ALLOWED' }),
      expect.objectContaining({ field: 'staffMemberId', code: 'FIELD_NOT_ALLOWED' }),
    ]);
  });
});

describe('requireEntryShape', () => {
  it('is 400 with the field errors, and silent for a right shape', () => {
    expect(() =>
      requireEntryShape({ isBreak: true, subjectId: null, staffMemberId: null }),
    ).not.toThrow();
    const error = refusal(() =>
      requireEntryShape({ isBreak: false, subjectId: null, staffMemberId: null }),
    );
    expect(error.status).toBe(400);
    expect(error.options.errors).toHaveLength(2);
  });
});

describe('requireUsableSlot', () => {
  const slot = { institutionId: 'inst-1', academicYearId: 'year-1', isBreak: false };

  it('accepts a period of the Institution’s current year', () => {
    expect(() => requireUsableSlot(slot, 'inst-1', 'year-1', false)).not.toThrow();
    expect(() => requireUsableSlot(slot, 'inst-1', 'year-1', true)).not.toThrow();
  });

  it.each([
    ['another year', { ...slot, academicYearId: 'year-0' }, false],
    ['another Institution', { ...slot, institutionId: 'inst-2' }, false],
    ['a break period for a lesson', { ...slot, isBreak: true }, false],
  ])('is 400 INVALID_SLOT for %s', (_name, given, entryIsBreak) => {
    const error = refusal(() => requireUsableSlot(given, 'inst-1', 'year-1', entryIsBreak));
    expect(error.status).toBe(400);
    expect(error.code).toBe('INVALID_SLOT');
  });

  it('takes a break entry in a break period', () => {
    expect(() =>
      requireUsableSlot({ ...slot, isBreak: true }, 'inst-1', 'year-1', true),
    ).not.toThrow();
  });
});

describe('translateEntryError', () => {
  it('answers the two unique indexes in the codes of the rules', () => {
    const section = translateEntryError({
      code: '23505',
      constraint: 'uq_timetable_section_slot',
    }) as AppException;
    expect([section.status, section.code]).toEqual([409, 'SECTION_SLOT_TAKEN']);
    const teacher = translateEntryError({
      code: '23505',
      constraint: 'uq_timetable_teacher_slot',
    }) as AppException;
    expect([teacher.status, teacher.code]).toEqual([409, 'TEACHER_DOUBLE_BOOKED']);
  });

  it('leaves any other error alone', () => {
    const other = new Error('boom');
    expect(translateEntryError(other)).toBe(other);
  });
});
