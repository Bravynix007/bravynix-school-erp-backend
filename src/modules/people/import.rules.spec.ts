import type { OpenSection } from '../academic-setup/index.js';
import { SectionIndex, checkRow, phoneDigits, splitName } from './import.rules.js';

const section = (className: string, sectionName: string, n: number): OpenSection => ({
  sectionId: `section-${n}`,
  classId: `class-${className}`,
  className,
  sectionName,
});
const index = new SectionIndex([
  section('9th', 'A', 1),
  section('9th', 'B', 2),
  section('Nursery', 'A', 3),
]);
const row = (cells: string[]) => ({ cells });
const good = ['Asha Devi Rao', '14', '9th', 'A', 'Meera Rao', '9876543210', 'Meera@Example.com'];
const message = (cells: string[]) => (checkRow(row(cells), index) as { message: string }).message;
const withCell = (position: number, value: string) =>
  good.map((cell, at) => (at === position ? value : cell));

describe('checkRow', () => {
  it('turns a good row into a student with one guardian', () => {
    expect(checkRow(row(good), index)).toEqual({
      student: {
        firstName: 'Asha Devi',
        lastName: 'Rao',
        rollNumber: '14',
        classId: 'class-9th',
        sectionId: 'section-1',
        guardian: {
          firstName: 'Meera',
          lastName: 'Rao',
          phone: '9876543210',
          email: 'meera@example.com',
        },
      },
    });
  });

  it('finds the class and section however they are cased or spaced', () => {
    const typed = good.map((cell, at) => (at === 2 ? ' 9TH ' : at === 3 ? ' b ' : cell));
    expect(checkRow(row(typed), index)).toMatchObject({ student: { sectionId: 'section-2' } });
  });

  it('leaves the email empty when the cell is empty, and a guardian with one name has no last name', () => {
    const found = checkRow(row(withCell(4, 'Meera').map((c, i) => (i === 6 ? '' : c))), index);
    expect(found).toMatchObject({
      student: { guardian: { firstName: 'Meera', lastName: null, email: null } },
    });
  });

  it.each([
    ['a missing name', 0, '', 'Name is required'],
    ['a missing roll number', 1, ' ', 'RollNumber is required'],
    [
      'a roll number over 20 characters',
      1,
      '1'.repeat(21),
      'RollNumber is longer than 20 characters',
    ],
    ['a missing class', 2, '', 'Class is required'],
    ['an unknown class', 2, '9th grade', "'9th grade' is not a recognized class"],
    ['a missing section', 3, '', 'Section is required'],
    ['a section the class does not have', 3, 'Z', "'Z' is not a recognized section of class '9th'"],
    ['a missing guardian name', 4, '', 'GuardianName is required'],
    ['a missing guardian phone', 5, '', 'GuardianPhone is required'],
    ['a phone of letters', 5, 'call me', 'GuardianPhone is not a valid phone number'],
    ['a phone of 5 digits', 5, '12345', 'GuardianPhone is not a valid phone number'],
    [
      'an email without an at sign',
      6,
      'meera.example.com',
      'GuardianEmail is not a valid email address',
    ],
  ])('skips a row with %s', (_name, position, value, expected) => {
    expect(message(withCell(position, value))).toBe(expected);
  });

  it('skips a name of 101 characters in a part', () => {
    expect(message(withCell(0, `${'a'.repeat(101)} Rao`))).toBe(
      'Name is longer than 100 characters',
    );
    expect(message(withCell(4, `${'a'.repeat(101)} Rao`))).toBe(
      'GuardianName is longer than 100 characters',
    );
  });

  it('looks for the section among the sections of the class that was named', () => {
    const nursery = good.map((cell, at) => (at === 2 ? 'Nursery' : at === 3 ? 'B' : cell));
    expect(message(nursery)).toBe("'B' is not a recognized section of class 'Nursery'");
  });

  it('skips a row with too many or too few cells and says how many it found', () => {
    expect(message(good.slice(0, 5))).toBe('Expected 7 columns but found 5');
    expect(message([...good, 'extra'])).toBe('Expected 7 columns but found 8');
  });

  it('never repeats a phone number or an email in a message, as the result is kept for 7 days', () => {
    expect(message(withCell(5, '98765abc'))).not.toContain('98765');
    expect(message(withCell(6, 'someone@@example.com'))).not.toContain('someone');
  });
});

describe('splitName', () => {
  it('splits at the last space and tidies the spaces', () => {
    expect(splitName('  Asha   Devi  Rao ')).toEqual({ firstName: 'Asha Devi', lastName: 'Rao' });
    expect(splitName('Asha')).toEqual({ firstName: 'Asha', lastName: null });
  });
});

describe('phoneDigits', () => {
  it.each([
    ['9876543210', '9876543210'],
    ['98765 43210', '9876543210'],
    ['98765-43210', '9876543210'],
    ['+91 98765 43210', '9876543210'],
    ['+919876543210', '9876543210'],
    ['123456', '123456'],
  ])('reads %s as %s', (typed, digits) => {
    expect(phoneDigits(typed)).toBe(digits);
  });

  it.each(['', '12345', '1234567890123456', '+44 7911 123456', '98765x43210'])(
    'refuses %s',
    (typed) => {
      expect(phoneDigits(typed)).toBeNull();
    },
  );
});
