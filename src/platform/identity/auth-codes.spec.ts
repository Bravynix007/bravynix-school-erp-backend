import { endReasonName, userTypeFor } from './auth-codes.js';

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

describe('endReasonName', () => {
  it('names the seven end reasons for the client', () => {
    expect([1, 2, 3, 4, 5, 6, 7].map(endReasonName)).toEqual([
      'logout',
      'logout_all',
      'blocked',
      'admin_revoked',
      'token_reused',
      'expired',
      'email_changed',
    ]);
  });

  it('falls back to expired for a missing or unknown reason', () => {
    expect(endReasonName(null)).toBe('expired');
    expect(endReasonName(99)).toBe('expired');
  });
});
