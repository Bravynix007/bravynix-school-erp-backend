import { body, problems } from '../../../test/support/dto-validation.js';
import { PlaceDto } from './place.dto.js';

const id = '0192f3b0-0000-7000-8000-000000000001';

describe('PlaceDto', () => {
  it('takes any part of the place, a part as null, or none', async () => {
    expect(await problems(body(PlaceDto, {}))).toEqual([]);
    expect(await problems(body(PlaceDto, { countryId: id, stateId: id, cityId: id }))).toEqual([]);
    expect(
      await problems(body(PlaceDto, { countryId: null, stateId: null, cityId: null })),
    ).toEqual([]);
  });

  it.each(['countryId', 'stateId', 'cityId'])('refuses %s that is not a UUID', async (field) => {
    expect(await problems(body(PlaceDto, { [field]: 'not-a-uuid' }))).toContainEqual({
      field,
      code: 'INVALID_FORMAT',
    });
    expect(await problems(body(PlaceDto, { [field]: 5 }))).toContainEqual(
      expect.objectContaining({ field }),
    );
  });
});
