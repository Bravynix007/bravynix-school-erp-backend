import { AppException } from '../../common/http/app-exception.js';
import { MASTER_SPECS } from './master.catalog.js';
import { listFilters, planInsert, planMove } from './master.rules.js';

function refusal(run: () => unknown): AppException {
  try {
    run();
  } catch (error) {
    return error as AppException;
  }
  throw new Error('Expected a refusal');
}

describe('planInsert', () => {
  it('puts a new entry last when no position is asked for', () => {
    expect(planInsert(undefined, 7)).toEqual({ position: 8, shift: null });
    expect(planInsert(undefined, 0)).toEqual({ position: 1, shift: null });
  });

  it('puts it at the position asked for and moves the entries from there down one', () => {
    expect(planInsert(3, 7)).toEqual({
      position: 3,
      shift: { range: { from: 3, to: 7 }, by: 1 },
    });
    expect(planInsert(1, 1)).toEqual({ position: 1, shift: { range: { from: 1, to: 1 }, by: 1 } });
  });

  it('accepts the position just past the end as the end', () => {
    expect(planInsert(8, 7)).toEqual({ position: 8, shift: null });
  });

  it.each([0, 9, -1])('refuses position %i in a list of 7, naming the last one', (position) => {
    const error = refusal(() => planInsert(position, 7));
    expect(error.options.errors).toEqual([
      expect.objectContaining({
        field: 'displayOrder',
        code: 'OUT_OF_RANGE',
        params: { min: 1, max: 8 },
      }),
    ]);
  });
});

describe('planMove', () => {
  it('moves the entries it passes the other way: up the list pushes them down', () => {
    expect(planMove(5, 2, 8)).toEqual({ range: { from: 2, to: 4 }, by: 1 });
    expect(planMove(2, 1, 8)).toEqual({ range: { from: 1, to: 1 }, by: 1 });
  });

  it('down the list pulls the ones it passes up', () => {
    expect(planMove(2, 5, 8)).toEqual({ range: { from: 3, to: 5 }, by: -1 });
    expect(planMove(7, 8, 8)).toEqual({ range: { from: 8, to: 8 }, by: -1 });
  });

  it('does nothing when the entry is already there', () => {
    expect(planMove(3, 3, 8)).toBeNull();
  });

  it.each([0, 9])('refuses position %i in a list of 8', (target) => {
    const error = refusal(() => planMove(3, target, 8));
    expect(error.options.errors?.[0]).toMatchObject({
      field: 'displayOrder',
      params: { min: 1, max: 8 },
    });
  });
});

describe('listFilters', () => {
  it('turns the filters a master has into columns', () => {
    const country = '0192f3b0-0000-7000-8000-000000000001';
    expect(listFilters(MASTER_SPECS.states, { countryId: country })).toEqual([
      { column: 'country_id', value: country },
    ]);
    expect(listFilters(MASTER_SPECS['predefined-classes'], {})).toEqual([]);
  });

  it('needs the state for cities', () => {
    const error = refusal(() => listFilters(MASTER_SPECS.cities, {}));
    expect(error.options.errors).toEqual([
      expect.objectContaining({ field: 'stateId', code: 'REQUIRED' }),
    ]);
  });

  it('refuses a filter the master does not have, and reports every problem at once', () => {
    const error = refusal(() =>
      listFilters(MASTER_SPECS.cities, { countryId: 'x', classCategoryId: 'y' }),
    );
    expect(error.options.errors?.map((e) => [e.field, e.code])).toEqual([
      ['countryId', 'FIELD_NOT_ALLOWED'],
      ['classCategoryId', 'FIELD_NOT_ALLOWED'],
      ['stateId', 'REQUIRED'],
    ]);
  });
});
