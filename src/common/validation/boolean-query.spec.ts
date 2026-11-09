import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { BooleanQuery } from './boolean-query.js';

class Probe {
  @BooleanQuery()
  flag?: boolean;
}

const check = (flag?: unknown) => {
  const probe = plainToInstance(Probe, flag === undefined ? {} : { flag });
  return { probe, errors: validateSync(probe) };
};

describe('BooleanQuery', () => {
  it('reads true and false from the text of a query string', () => {
    expect(check('true')).toMatchObject({ probe: { flag: true }, errors: [] });
    expect(check('false')).toMatchObject({ probe: { flag: false }, errors: [] });
  });

  it('may be left out, and refuses anything else', () => {
    expect(check().errors).toEqual([]);
    expect(check('yes').errors).toHaveLength(1);
    expect(check('1').errors).toHaveLength(1);
  });
});
