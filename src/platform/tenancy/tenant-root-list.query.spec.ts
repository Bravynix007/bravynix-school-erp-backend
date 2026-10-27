import { createValidationPipe } from '../../common/validation/validation.js';
import { AppException } from '../../common/http/app-exception.js';
import { ListInstitutionsQueryDto } from './institution.dto.js';
import { ListSocietiesQueryDto } from './society.dto.js';

const pipe = createValidationPipe();
const query = <T>(metatype: new () => T, value: unknown) =>
  pipe.transform(value, { type: 'query', metatype }) as Promise<T>;

describe('the Society and Institution list queries', () => {
  it('read repeated or single status values as numbers, and blocked as a boolean', async () => {
    expect(
      await query(ListSocietiesQueryDto, { status: ['0', '1'], blocked: 'true' }),
    ).toMatchObject({
      status: [0, 1],
      blocked: true,
    });
    expect(
      await query(ListInstitutionsQueryDto, { status: '0', blocked: 'false', page: '2' }),
    ).toMatchObject({
      status: [0],
      blocked: false,
      page: 2,
    });
  });

  it('use the defaults when nothing is asked', async () => {
    expect(await query(ListSocietiesQueryDto, {})).toMatchObject({ page: 1, limit: 20 });
  });

  it.each([
    { status: '2' },
    { status: 'x' },
    { status: '' },
    { blocked: 'maybe' },
    { societyId: 'nope' },
  ])('refuse %j', async (value) => {
    await expect(query(ListInstitutionsQueryDto, value)).rejects.toBeInstanceOf(AppException);
  });
});
