import { body, problems } from '../../../test/support/dto-validation.js';
import { CreateAccessBlockDto } from './access-block.dto.js';

const society = '0192f3b0-2c3d-7e4f-9a50-2b3c4d5e6f70';
const institution = '0192f3b7-4e5f-7061-9c72-4d5e6f708192';

describe('CreateAccessBlockDto', () => {
  it('takes a section, a Society, an optional Institution and a reason of 1 to 500 characters', async () => {
    for (const value of [
      { section: 'owners', societyId: society, reason: 'Dues' },
      { section: 'staff', societyId: society, institutionId: institution, reason: 'r'.repeat(500) },
      { section: 'students', societyId: society, institutionId: institution, reason: 'x' },
    ]) {
      expect(await problems(body(CreateAccessBlockDto, value))).toEqual([]);
    }
  });

  it.each([
    [{ societyId: society, reason: 'r' }, 'section', 'INVALID_CODE'],
    [{ section: 'everyone', societyId: society, reason: 'r' }, 'section', 'INVALID_CODE'],
    [{ section: 1, societyId: society, reason: 'r' }, 'section', 'INVALID_CODE'],
    [{ section: 'owners', reason: 'r' }, 'societyId', 'INVALID_FORMAT'],
    [{ section: 'owners', societyId: 'nope', reason: 'r' }, 'societyId', 'INVALID_FORMAT'],
    [
      { section: 'staff', societyId: society, institutionId: 'nope', reason: 'r' },
      'institutionId',
      'INVALID_FORMAT',
    ],
    [{ section: 'owners', societyId: society }, 'reason', 'INVALID_TYPE'],
    [{ section: 'owners', societyId: society, reason: '' }, 'reason', 'TOO_SHORT'],
    [{ section: 'owners', societyId: society, reason: 'r'.repeat(501) }, 'reason', 'TOO_LONG'],
    [
      { section: 'owners', societyId: society, reason: 'r', expires: 'x' },
      'expires',
      'FIELD_NOT_ALLOWED',
    ],
  ])('refuses %j', async (value, field, code) => {
    expect(await problems(body(CreateAccessBlockDto, value))).toContainEqual({ field, code });
  });
});
