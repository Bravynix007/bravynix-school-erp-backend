import { body, problems } from '../../../test/support/dto-validation.js';
import { VersionedReasonDto } from './reason.dto.js';

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
      code: 'INVALID_TYPE',
    });
  });
});
