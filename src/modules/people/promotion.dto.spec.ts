import { body, problems } from '../../../test/support/dto-validation.js';
import { PromoteClassDto, PromoteStudentDto } from './promotion.dto.js';

const id = (n: number) => `0192f3b0-0000-7000-8000-00000000000${n}`;
const target = { toAcademicYearId: id(1), toClassId: id(2), toSectionId: id(3) };
const batch = {
  institutionId: id(4),
  fromAcademicYearId: id(5),
  fromClassId: id(6),
  fromSectionId: id(7),
  ...target,
};

describe('PromoteStudentDto', () => {
  it('takes a target, with or without a roll number', async () => {
    expect(await problems(body(PromoteStudentDto, target))).toEqual([]);
    expect(await problems(body(PromoteStudentDto, { ...target, rollNumber: '14' }))).toEqual([]);
  });

  it('takes no target at all for a student who completes the final class', async () => {
    const none = { toAcademicYearId: null, toClassId: null, toSectionId: null };
    expect(await problems(body(PromoteStudentDto, none))).toEqual([]);
  });

  it.each([
    ['a target left out', { toAcademicYearId: id(1), toClassId: id(2) }, 'toSectionId'],
    ['a target that is not an ID', { ...target, toClassId: 'x' }, 'toClassId'],
    ['a blank roll number', { ...target, rollNumber: '  ' }, 'rollNumber'],
    ['a roll number of 21', { ...target, rollNumber: '1'.repeat(21) }, 'rollNumber'],
    ['a roll number that is null', { ...target, rollNumber: null }, 'rollNumber'],
  ])('refuses %s', async (_name, fields, field) => {
    const found = await problems(body(PromoteStudentDto, fields));
    expect(found.map((p) => p.field)).toContain(field);
  });
});

describe('PromoteClassDto', () => {
  it('takes a class, a target, and nothing else', async () => {
    expect(await problems(body(PromoteClassDto, batch))).toEqual([]);
  });

  it('takes every section, a subset of students and numbering again', async () => {
    const fields = { ...batch, fromSectionId: null, studentIds: [id(8)], keepRollNumbers: false };
    expect(await problems(body(PromoteClassDto, fields))).toEqual([]);
  });

  it('takes IDs in either case', async () => {
    const fields = {
      ...batch,
      fromClassId: id(6).toUpperCase(),
      studentIds: [id(8).toUpperCase()],
    };
    expect(await problems(body(PromoteClassDto, fields))).toEqual([]);
  });

  it.each([
    ['no Institution', { ...batch, institutionId: undefined }, 'institutionId'],
    ['no source section key', { ...batch, fromSectionId: undefined }, 'fromSectionId'],
    ['the same student twice', { ...batch, studentIds: [id(8), id(8)] }, 'studentIds'],
    ['a student that is not an ID', { ...batch, studentIds: ['x'] }, 'studentIds'],
    ['numbering as text', { ...batch, keepRollNumbers: 'false' }, 'keepRollNumbers'],
    ['a field that is not the promotion’s', { ...batch, rollNumber: '1' }, 'rollNumber'],
  ])('refuses %s', async (_name, fields, field) => {
    const found = await problems(body(PromoteClassDto, fields));
    expect(found.map((p) => p.field)).toContain(field);
  });
});
