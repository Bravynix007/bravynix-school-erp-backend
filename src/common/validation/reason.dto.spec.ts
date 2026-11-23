import { body, problems } from '../../../test/support/dto-validation.js';
import { VersionedReasonDto, VersionedStatedReasonDto } from './reason.dto.js';

describe('VersionedReasonDto', () => {
  it('needs a reason of 1 to 500 characters and the version', async () => {
    expect(await problems(body(VersionedReasonDto, { version: 1, reason: 'Dues' }))).toEqual([]);
    for (const value of [
      { version: 1 },
      { version: 1, reason: '' },
      { version: 1, reason: 'r'.repeat(501) },
    ]) {
      expect(await problems(body(VersionedReasonDto, value))).not.toEqual([]);
    }
    expect(await problems(body(VersionedReasonDto, { reason: 'x' }))).toContainEqual({
      field: 'version',
      code: 'REQUIRED',
    });
  });
});

describe('VersionedStatedReasonDto', () => {
  it('needs the version and a reason of 5 to 500 characters', async () => {
    for (const reason of ['Wrong', 'Raised twice', 'r'.repeat(500)]) {
      expect(await problems(body(VersionedStatedReasonDto, { version: 1, reason }))).toEqual([]);
    }
  });

  it.each([
    [{ version: 1 }, 'reason', 'REQUIRED'],
    [{ version: 1, reason: 'Oops' }, 'reason', 'TOO_SHORT'],
    [{ version: 1, reason: 'r'.repeat(501) }, 'reason', 'TOO_LONG'],
    [{ reason: 'Raised twice' }, 'version', 'REQUIRED'],
  ])('refuses %j', async (value, field, code) => {
    expect(await problems(body(VersionedStatedReasonDto, value))).toContainEqual({ field, code });
  });
});
