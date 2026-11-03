import { body, problems } from '../../../test/support/dto-validation.js';
import { CreateInstitutionDto, UpdateInstitutionDto } from './institution.dto.js';
import { CreateSocietyDto, UpdateSocietyDto } from './society.dto.js';

const institution = {
  name: 'Green Valley School',
  code: 'GVS01',
  address: { line1: '12 Lake Road' },
};
const society = { name: 'Sunrise Trust', code: 'SUN01' };

describe('a list where one object belongs is INVALID_TYPE, not a 500 or a silent null', () => {
  it.each([
    [CreateInstitutionDto, { ...institution, address: [] }, 'address'],
    [CreateInstitutionDto, { ...institution, phone: [] }, 'phone'],
    [CreateInstitutionDto, { ...institution, location: [] }, 'location'],
    [UpdateInstitutionDto, { version: 1, address: [] }, 'address'],
    [CreateSocietyDto, { ...society, address: [] }, 'address'],
    [CreateSocietyDto, { ...society, phone: [] }, 'phone'],
    [UpdateSocietyDto, { version: 1, phone: [{ number: '1' }] }, 'phone'],
  ])('%o refuses %j', async (dto, value, field) => {
    expect(await problems(body(dto as new () => unknown, value))).toContainEqual({
      field,
      code: 'INVALID_TYPE',
    });
  });

  it('refuses a list inside the list of owners', async () => {
    const found = await problems(body(CreateSocietyDto, { ...society, owners: [[]] }));
    expect(found).toContainEqual({ field: 'owners', code: 'INVALID_TYPE' });
  });
});
