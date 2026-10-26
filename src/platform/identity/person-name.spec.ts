import { personName } from './person-name.js';

describe('personName', () => {
  it('joins the names that exist, and gives null for none', () => {
    expect(personName('Asha', 'Rao')).toBe('Asha Rao');
    expect(personName('Asha', null)).toBe('Asha');
    expect(personName(null, 'Rao')).toBe('Rao');
    expect(personName(null, undefined)).toBeNull();
    expect(personName('', '')).toBeNull();
  });
});
