import { personRef } from './person-directory.js';

const user = { id: 'p1', email: 'asha@example.org', first_name: 'Asha', last_name: 'Rao' };
const held = (role_code: number) => ({ role_code, revoked_at: null });
const revoked = (role_code: number) => ({
  role_code,
  revoked_at: new Date('2026-10-01T00:00:00.000Z'),
});

describe('personRef', () => {
  it('names the person and the highest role they hold now', () => {
    expect(personRef(user, [held(3), held(2)])).toEqual({
      id: 'p1',
      displayName: 'Asha Rao',
      roleName: 'Society Owner',
    });
    expect(personRef(user, [held(1)]).roleName).toBe('Super Admin');
  });

  it('falls back to the role held last when none is held now', () => {
    expect(personRef(user, [revoked(3), revoked(2)]).roleName).toBe('Institution Admin');
  });

  it('prefers a role held now over a newer revoked one', () => {
    expect(personRef(user, [revoked(1), held(3)]).roleName).toBe('Institution Admin');
  });

  it('has no role name for a person who never held one, and shows the email when there is no name', () => {
    expect(personRef({ ...user, first_name: null, last_name: null }, [])).toEqual({
      id: 'p1',
      displayName: 'asha@example.org',
      roleName: null,
    });
  });

  it('has no role name for a code it does not know', () => {
    expect(personRef(user, [held(9)]).roleName).toBeNull();
  });
});
