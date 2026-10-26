import { AppException, type FieldError } from '../../common/http/app-exception.js';
import { createValidationPipe } from '../../common/validation/validation.js';
import { CreateSocietyDto, PauseDto, UpdateSocietyDto } from './society.dto.js';

const pipe = createValidationPipe();
const body = <T>(metatype: new () => T, value: unknown) =>
  pipe.transform(value, { type: 'body', metatype }) as Promise<T>;

async function problems(work: Promise<unknown>): Promise<Pick<FieldError, 'field' | 'code'>[]> {
  try {
    await work;
  } catch (error) {
    if (error instanceof AppException) {
      return (error.options.errors ?? []).map(({ field, code }) => ({ field, code }));
    }
    throw error;
  }
  return [];
}

const valid = { name: 'Sunrise Education Trust', code: 'SUN' };

describe('CreateSocietyDto', () => {
  it('takes a name and a code alone, and the whole profile', async () => {
    expect(await problems(body(CreateSocietyDto, valid))).toEqual([]);
    expect(
      await problems(
        body(CreateSocietyDto, {
          ...valid,
          description: 'Schools since 1998',
          email: 'office@sunrise.example.org',
          phone: { countryCode: '91', number: '9876543210' },
          website: 'http://sunrise.example.org',
          foundedDate: '1998-06-01',
          address: { line1: '1 Temple Road', line2: null, pincode: '560001' },
        }),
      ),
    ).toEqual([]);
  });

  it.each([
    [{ ...valid, code: undefined }, 'code', 'REQUIRED'],
    [{ ...valid, name: '' }, 'name', 'REQUIRED'],
    [{ ...valid, code: 'c'.repeat(51) }, 'code', 'TOO_LONG'],
    [{ ...valid, description: '' }, 'description', 'TOO_SHORT'],
    [{ ...valid, website: 'sunrise.org' }, 'website', 'INVALID_FORMAT'],
    [{ ...valid, website: 'ftp://sunrise.org' }, 'website', 'INVALID_FORMAT'],
    [{ ...valid, foundedDate: '01-06-1998' }, 'foundedDate', 'INVALID_FORMAT'],
    [{ ...valid, foundedDate: '2026-02-30' }, 'foundedDate', 'INVALID_FORMAT'],
    [{ ...valid, address: { line1: '' } }, 'address.line1', 'TOO_SHORT'],
    [{ ...valid, address: { city: 'Pune' } }, 'address.city', 'FIELD_NOT_ALLOWED'],
    [{ ...valid, status: 0 }, 'status', 'FIELD_NOT_ALLOWED'],
  ])('refuses %j', async (value, field, code) => {
    expect(await problems(body(CreateSocietyDto, value))).toContainEqual({ field, code });
  });
});

describe('UpdateSocietyDto', () => {
  it('needs the version, and takes null to clear what is optional but not the name', async () => {
    expect(await problems(body(UpdateSocietyDto, { version: 2 }))).toEqual([]);
    expect(
      await problems(
        body(UpdateSocietyDto, { version: 2, description: null, phone: null, address: null }),
      ),
    ).toEqual([]);
    expect(await problems(body(UpdateSocietyDto, { name: 'x' }))).toContainEqual({
      field: 'version',
      code: 'INVALID_TYPE',
    });
    expect(await problems(body(UpdateSocietyDto, { version: 2, name: null }))).not.toEqual([]);
  });

  it.each(['code', 'status', 'accessPause', 'updatedBy'])(
    'refuses %s as a field',
    async (field) => {
      expect(await problems(body(UpdateSocietyDto, { version: 2, [field]: 'x' }))).toContainEqual({
        field,
        code: 'FIELD_NOT_ALLOWED',
      });
    },
  );
});

describe('PauseDto', () => {
  it('needs a reason of 1 to 500 characters and the version', async () => {
    expect(await problems(body(PauseDto, { version: 1, reason: 'Dues' }))).toEqual([]);
    for (const value of [
      { version: 1 },
      { version: 1, reason: '' },
      { version: 1, reason: 'r'.repeat(501) },
    ]) {
      expect(await problems(body(PauseDto, value))).not.toEqual([]);
    }
    expect(await problems(body(PauseDto, { reason: 'x' }))).toContainEqual({
      field: 'version',
      code: 'INVALID_TYPE',
    });
  });
});
