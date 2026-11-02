import { plainToInstance } from 'class-transformer';
import { LowerCaseUuid } from './lower-case-uuid.js';

class Probe {
  @LowerCaseUuid()
  one?: unknown;

  @LowerCaseUuid()
  many?: unknown;
}

const id = '0195F0C2-7A1B-7C3D-8E4F-0123456789AB';

describe('LowerCaseUuid', () => {
  it('lowers a UUID and each UUID of a list', () => {
    const probe = plainToInstance(Probe, { one: id, many: [id, id.toLowerCase()] });
    expect(probe.one).toBe(id.toLowerCase());
    expect(probe.many).toEqual([id.toLowerCase(), id.toLowerCase()]);
  });

  it('leaves null, numbers and other values for the validators to refuse', () => {
    const probe = plainToInstance(Probe, { one: null, many: [1, null] });
    expect(probe.one).toBeNull();
    expect(probe.many).toEqual([1, null]);
    expect(plainToInstance(Probe, { one: 5 }).one).toBe(5);
  });
});
