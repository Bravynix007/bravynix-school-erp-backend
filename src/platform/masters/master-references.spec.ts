import { AppException } from '../../common/http/app-exception.js';
import type { Tx } from '../database/index.js';
import { MasterReferences } from './master-references.js';
import type { MasterRepository } from './master.repository.js';

const tx = {} as Tx;

function build(statuses: Record<string, number> = {}, parents: Record<string, string> = {}) {
  const statusesOf = vi
    .fn<MasterRepository['statusesOf']>()
    .mockImplementation((_tx, _table, ids) =>
      Promise.resolve(new Map(ids.filter((id) => id in statuses).map((id) => [id, statuses[id]!]))),
    );
  const parentOf = vi
    .fn<MasterRepository['parentOf']>()
    .mockImplementation((_tx, _table, id) => Promise.resolve(parents[id]));
  const classCategories = vi.fn<MasterRepository['classCategories']>().mockResolvedValue([]);
  const predefinedClass = vi.fn<MasterRepository['predefinedClass']>();
  const predefinedSection = vi.fn<MasterRepository['predefinedSection']>();
  const references = new MasterReferences({
    statusesOf,
    parentOf,
    classCategories,
    predefinedClass,
    predefinedSection,
  } as unknown as MasterRepository);
  return { references, statusesOf, parentOf, classCategories, predefinedClass, predefinedSection };
}

async function refusal(work: Promise<unknown>): Promise<AppException> {
  try {
    await work;
  } catch (error) {
    if (error instanceof AppException) return error;
    throw error;
  }
  throw new Error('expected a refusal');
}

describe('MasterReferences.requireAllShown', () => {
  it('accepts shown entries, asking once', async () => {
    const t = build({ a: 1, b: 1 });
    await t.references.requireAllShown(tx, 'class_categories', [
      { id: 'a', field: 'x[0]' },
      { id: 'b', field: 'x[1]' },
    ]);
    expect(t.statusesOf).toHaveBeenCalledOnce();
  });

  it('is 404 for an entry that is not there, and 422 REFERENCE_INACTIVE naming the field for a hidden one', async () => {
    const t = build({ a: 1, hidden: 0 });
    expect(
      (await refusal(t.references.requireShown(tx, 'countries', 'gone', 'countryId'))).status,
    ).toBe(404);
    const inactive = await refusal(
      t.references.requireAllShown(tx, 'class_categories', [
        { id: 'a', field: 'x[0]' },
        { id: 'hidden', field: 'x[1]' },
      ]),
    );
    expect(inactive).toMatchObject({ status: 422, code: 'REFERENCE_INACTIVE' });
    expect(inactive.options.errors).toEqual([expect.objectContaining({ field: 'x[1]' })]);
  });

  it('accepts an empty list without asking', async () => {
    const t = build();
    await t.references.requireAllShown(tx, 'class_categories', []);
    expect(t.statusesOf).toHaveBeenCalledOnce();
  });
});

describe('MasterReferences.requirePlace', () => {
  const shown = { country: 1, other: 1, state: 1, city: 1, state2: 1 };

  it('accepts no place, a country, a country and state, and a whole chain', async () => {
    const t = build(shown, { state: 'country', city: 'state' });
    const accepted = [
      {},
      { countryId: 'country' },
      { countryId: 'country', stateId: 'state' },
      { countryId: 'country', stateId: 'state', cityId: 'city' },
      { countryId: null, stateId: null, cityId: null },
    ].map((place) => t.references.requirePlace(tx, place, 'address'));
    await expect(Promise.all(accepted)).resolves.toHaveLength(5);
  });

  it('wants the parent of a part, naming the field under the prefix', async () => {
    const t = build(shown, { state: 'country', city: 'state' });
    const noCountry = await refusal(t.references.requirePlace(tx, { stateId: 'state' }, 'address'));
    expect(noCountry.options.errors).toEqual([
      expect.objectContaining({ field: 'address.countryId', code: 'REQUIRED' }),
    ]);
    const noState = await refusal(
      t.references.requirePlace(tx, { countryId: 'country', cityId: 'city' }, 'address'),
    );
    expect(noState.options.errors).toEqual([
      expect.objectContaining({ field: 'address.stateId', code: 'REQUIRED' }),
    ]);
    expect(t.statusesOf).not.toHaveBeenCalled();
  });

  it('refuses a state of another country and a city of another state with INVALID_VALUE on that part', async () => {
    const t = build(shown, { state: 'country', city: 'state2', state2: 'country' });
    const state = await refusal(
      t.references.requirePlace(tx, { countryId: 'other', stateId: 'state' }, 'address'),
    );
    expect(state.options.errors).toEqual([
      expect.objectContaining({ field: 'address.stateId', code: 'INVALID_VALUE' }),
    ]);
    t.statusesOf.mockImplementation((_tx, _table, ids) =>
      Promise.resolve(new Map(ids.map((id) => [id, 1]))),
    );
    const city = await refusal(
      t.references.requirePlace(
        tx,
        { countryId: 'country', stateId: 'state', cityId: 'city' },
        'address',
      ),
    );
    expect(city.options.errors).toEqual([
      expect.objectContaining({ field: 'address.cityId', code: 'INVALID_VALUE' }),
    ]);
  });

  it('is 404 for a part that is not there and 422 for one that is hidden', async () => {
    const gone = build({ country: 1 }, {});
    expect(
      (
        await refusal(
          gone.references.requirePlace(tx, { countryId: 'country', stateId: 'nope' }, 'address'),
        )
      ).status,
    ).toBe(404);
    const hidden = build({ country: 0 }, {});
    const error = await refusal(
      hidden.references.requirePlace(tx, { countryId: 'country' }, 'address'),
    );
    expect(error).toMatchObject({ status: 422, code: 'REFERENCE_INACTIVE' });
    expect(error.options.errors).toEqual([expect.objectContaining({ field: 'address.countryId' })]);
  });
});

describe('MasterReferences.classCategories', () => {
  it('asks the repository for the categories, hidden ones too', async () => {
    const t = build();
    await t.references.classCategories(tx, ['a']);
    expect(t.classCategories).toHaveBeenCalledWith(tx, ['a']);
  });
});

describe('MasterReferences.requirePredefinedClass and requirePredefinedSection', () => {
  const found = {
    id: 'p1',
    code: 'C09',
    name: '9th',
    status: 1,
    categoryId: 'c1',
    categoryCode: 'HIGH_SCHOOL',
  };

  it('gives a shown predefined class with its category, without its status', async () => {
    const t = build();
    t.predefinedClass.mockResolvedValue(found);
    expect(await t.references.requirePredefinedClass(tx, 'p1', 'predefinedClassId')).toEqual({
      id: 'p1',
      code: 'C09',
      name: '9th',
      categoryId: 'c1',
      categoryCode: 'HIGH_SCHOOL',
    });
  });

  it('is 404 for one that is not there and 422 REFERENCE_INACTIVE naming the field for a hidden one', async () => {
    const t = build();
    t.predefinedClass.mockResolvedValueOnce(undefined);
    expect(
      (
        await refusal(
          t.references.requirePredefinedClass(tx, 'gone', 'classes[1].predefinedClassId'),
        )
      ).status,
    ).toBe(404);
    t.predefinedClass.mockResolvedValueOnce({ ...found, status: 0 });
    const hidden = await refusal(
      t.references.requirePredefinedClass(tx, 'p1', 'classes[1].predefinedClassId'),
    );
    expect(hidden).toMatchObject({ status: 422, code: 'REFERENCE_INACTIVE' });
    expect(hidden.options.errors).toEqual([
      expect.objectContaining({ field: 'classes[1].predefinedClassId' }),
    ]);
  });

  it('does the same for a predefined section', async () => {
    const t = build();
    t.predefinedSection.mockResolvedValueOnce({ id: 's1', code: 'A', name: 'A', status: 1 });
    expect(await t.references.requirePredefinedSection(tx, 's1', 'predefinedSectionId')).toEqual({
      id: 's1',
      code: 'A',
      name: 'A',
    });
    t.predefinedSection.mockResolvedValueOnce(undefined);
    expect((await refusal(t.references.requirePredefinedSection(tx, 'x', 'f'))).status).toBe(404);
    t.predefinedSection.mockResolvedValueOnce({ id: 's1', code: 'A', name: 'A', status: 0 });
    expect(await refusal(t.references.requirePredefinedSection(tx, 's1', 'f'))).toMatchObject({
      status: 422,
      code: 'REFERENCE_INACTIVE',
    });
  });
});
