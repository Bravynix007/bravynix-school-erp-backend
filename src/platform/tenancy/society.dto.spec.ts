import { body, problems } from '../../../test/support/dto-validation.js';
import { CreateSocietyDto, UpdateSocietyDto } from './society.dto.js';

const valid = { name: 'Sunrise Education Trust', code: 'SUN' };

const owner = (n: number) => ({ email: `owner${String(n)}@example.com` });

describe('CreateSocietyDto owners', () => {
  it('takes one to three Owners by email', async () => {
    for (const owners of [[owner(1)], [owner(1), owner(2), owner(3)]]) {
      expect(await problems(body(CreateSocietyDto, { ...valid, owners }))).toEqual([]);
    }
  });

  it('refuses none, four, and a bad address, naming the field', async () => {
    expect(await problems(body(CreateSocietyDto, { ...valid, owners: [] }))).toContainEqual({
      field: 'owners',
      code: 'TOO_FEW',
    });
    expect(
      await problems(body(CreateSocietyDto, { ...valid, owners: [1, 2, 3, 4].map(owner) })),
    ).toContainEqual({ field: 'owners', code: 'TOO_MANY' });
    expect(
      await problems(body(CreateSocietyDto, { ...valid, owners: [{ email: 'nope' }] })),
    ).toContainEqual({ field: 'owners[0].email', code: 'INVALID_FORMAT' });
  });
});

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
