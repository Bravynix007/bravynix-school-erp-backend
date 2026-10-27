import { body, problems } from '../../../test/support/dto-validation.js';
import { CreateInstitutionDto, UpdateInstitutionDto } from './institution.dto.js';

const valid = { name: 'Green Valley', code: 'GVS', address: { line1: '12 Lake Road' } };

describe('CreateInstitutionDto', () => {
  it('takes the required fields alone and keeps nested objects as classes', async () => {
    expect(await problems(body(CreateInstitutionDto, valid))).toEqual([]);
    const full = await body(CreateInstitutionDto, {
      ...valid,
      boardCode: 6,
      gstin: '29ABCDE1234F1Z5',
      phone: { countryCode: '91', number: '9876543210' },
      location: { latitude: -90, longitude: 180 },
    });
    expect(full.location).toMatchObject({ latitude: -90, longitude: 180 });
  });

  it.each([
    [{ ...valid, name: undefined }, 'name', 'REQUIRED'],
    [{ ...valid, address: undefined }, 'address', 'REQUIRED'],
    [{ ...valid, address: null }, 'address', 'REQUIRED'],
    [{ ...valid, address: {} }, 'address.line1', 'INVALID_TYPE'],
    [{ ...valid, boardCode: 0 }, 'boardCode', 'INVALID_CODE'],
    [{ ...valid, boardCode: 1.5 }, 'boardCode', 'INVALID_TYPE'],
    [{ ...valid, gstin: '29ABCDE1234F1Z' }, 'gstin', 'INVALID_FORMAT'],
    [{ ...valid, email: 'not-an-email' }, 'email', 'INVALID_FORMAT'],
    [{ ...valid, societyId: 'nope' }, 'societyId', 'FIELD_NOT_ALLOWED'],
    [{ ...valid, telephone: 't'.repeat(21) }, 'telephone', 'TOO_LONG'],
    [{ ...valid, location: { latitude: 0, longitude: 181 } }, 'location.longitude', 'OUT_OF_RANGE'],
    [
      { ...valid, location: { latitude: 0.1234567, longitude: 0 } },
      'location.latitude',
      'INVALID_TYPE',
    ],
    [{ ...valid, location: { latitude: '1', longitude: 0 } }, 'location.latitude', 'INVALID_TYPE'],
  ])('refuses %j', async (value, field, code) => {
    expect(await problems(body(CreateInstitutionDto, value))).toContainEqual({ field, code });
  });
});

describe('UpdateInstitutionDto', () => {
  it('needs only the version; an omitted field stays out', async () => {
    expect(await problems(body(UpdateInstitutionDto, { version: 1 }))).toEqual([]);
    expect(await problems(body(UpdateInstitutionDto, {}))).toContainEqual({
      field: 'version',
      code: 'INVALID_TYPE',
    });
  });

  it('takes null to clear what is optional, never for the name or the address', async () => {
    expect(
      await problems(
        body(UpdateInstitutionDto, {
          version: 1,
          place: null,
          phone: null,
          location: null,
          boardCode: null,
        }),
      ),
    ).toEqual([]);
    expect(await problems(body(UpdateInstitutionDto, { version: 1, name: null }))).not.toEqual([]);
    expect(await problems(body(UpdateInstitutionDto, { version: 1, address: null }))).not.toEqual(
      [],
    );
  });

  it.each(['code', 'societyId', 'status', 'blockedSections', 'createdBy'])(
    'refuses %s as a field',
    async (field) => {
      expect(
        await problems(body(UpdateInstitutionDto, { version: 1, [field]: 'x' })),
      ).toContainEqual({
        field,
        code: 'FIELD_NOT_ALLOWED',
      });
    },
  );
});
