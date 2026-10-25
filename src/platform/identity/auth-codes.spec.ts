import { userTypeFor } from './auth-codes.js';

describe('userTypeFor', () => {
  it('names each role code for the client', () => {
    expect([1, 2, 3, 4, 5].map((code) => userTypeFor(code))).toEqual([
      { userType: 1, userTypeName: 'super_admin' },
      { userType: 2, userTypeName: 'society_owner' },
      { userType: 3, userTypeName: 'institution_admin' },
      { userType: 4, userTypeName: 'teacher_staff' },
      { userType: 5, userTypeName: 'student_parent' },
    ]);
  });

  it('is null until a context is active, and for a code that is not a role', () => {
    expect(userTypeFor(null)).toEqual({ userType: null, userTypeName: null });
    expect(userTypeFor(0)).toEqual({ userType: null, userTypeName: null });
    expect(userTypeFor(6)).toEqual({ userType: null, userTypeName: null });
  });
});
