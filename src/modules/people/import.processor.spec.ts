import { AppException } from '../../common/http/app-exception.js';
import { rowProblem } from './import.processor.js';

const conflict = (code: string) => AppException.conflict(code);
const duplicateOn = (constraint: string) =>
  Object.assign(new Error('duplicate'), { code: '23505', constraint });

describe('rowProblem', () => {
  it('says a roll number that is taken in the section', () => {
    expect(rowProblem(duplicateOn('uq_placements_roll'))).toBe(
      'RollNumber is already used in this section',
    );
  });

  it.each(['ROLE_CONFLICT', 'ACCOUNT_BLOCKED', 'INVALID_STATE', 'EMAIL_IN_USE'])(
    'says a guardian email that cannot be linked for %s, without repeating the email',
    (code) => {
      expect(rowProblem(conflict(code))).toMatch(
        /^GuardianEmail belongs to an account that cannot/,
      );
    },
  );

  it('says a year or a section that closed while the import ran', () => {
    expect(rowProblem(AppException.businessRule('YEAR_NOT_ACTIVE'))).toBeTruthy();
    expect(rowProblem(AppException.businessRule('INACTIVE_SECTION'))).toBeTruthy();
  });

  it.each([
    ['a lost connection', Object.assign(new Error('terminated'), { code: '57P01' })],
    ['another unique violation', duplicateOn('uq_students_institution_admission_no')],
    ['a refusal that is not about the row', AppException.notFound()],
    ['something that is not an error', 'nope'],
  ])(
    'is not a problem of the row for %s, so the batch stops and the job tries again',
    (_name, error) => {
      expect(rowProblem(error)).toBeNull();
    },
  );
});
