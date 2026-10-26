import { AppException } from '../../common/http/app-exception.js';
import { createValidationPipe } from '../../common/validation/validation.js';
import { RefreshTokenDto } from './refresh-token.dto.js';

const pipe = createValidationPipe();
const refused = async (value: unknown): Promise<boolean> => {
  try {
    await pipe.transform(value, { type: 'body', metatype: RefreshTokenDto });
    return false;
  } catch (error) {
    if (error instanceof AppException) return true;
    throw error;
  }
};

describe('RefreshTokenDto (AUTH-05)', () => {
  it('lets the console send nothing, and the app send a token', async () => {
    expect(await refused({})).toBe(false);
    expect(await refused({ refreshToken: 'rt_abc' })).toBe(false);
  });

  it.each([null, '', 5, 'r'.repeat(201)])('refuses a present token of %j', async (refreshToken) => {
    expect(await refused({ refreshToken })).toBe(true);
  });
});
