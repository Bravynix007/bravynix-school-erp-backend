import { AppException } from '../../common/http/app-exception.js';
import {
  emailInUse,
  maskEmail,
  nextSeat,
  requireCanHoldRole,
  requireNotSelf,
} from './account-rules.js';
import type { AccountRow } from './account.repository.js';
import { AccountStatus } from './auth-codes.js';

const person = (account_status: number) => ({ account_status }) as AccountRow;

describe('nextSeat', () => {
  it('takes the lowest free seat, including one freed in the middle', () => {
    expect(nextSeat([])).toBe(1);
    expect(nextSeat([1, 3])).toBe(2);
    expect(nextSeat([2, 3])).toBe(1);
  });

  it('refuses when all three are taken', () => {
    expect(() => nextSeat([1, 2, 3])).toThrow(
      expect.objectContaining({ status: 409, code: 'SEAT_LIMIT_REACHED' }),
    );
  });
});

describe('requireCanHoldRole', () => {
  it('lets a Pending or Active person hold a role', () => {
    expect(() => requireCanHoldRole(person(AccountStatus.Pending))).not.toThrow();
    expect(() => requireCanHoldRole(person(AccountStatus.Active))).not.toThrow();
  });

  it('refuses a blocked person and an inactive one with different answers', () => {
    expect(() => requireCanHoldRole(person(AccountStatus.Blocked))).toThrow(
      expect.objectContaining({ status: 409, code: 'ACCOUNT_BLOCKED' }),
    );
    expect(() => requireCanHoldRole(person(AccountStatus.Inactive))).toThrow(
      expect.objectContaining({ status: 409, code: 'INVALID_STATE' }),
    );
  });
});

describe('requireNotSelf', () => {
  it('refuses an administrator acting on their own account', () => {
    expect(() => requireNotSelf('a', 'b')).not.toThrow();
    expect(() => requireNotSelf('a', 'a')).toThrow(
      expect.objectContaining({ status: 409, code: 'CANNOT_ACT_ON_SELF' }),
    );
  });
});

describe('maskEmail', () => {
  it('keeps the first letter and the domain only', () => {
    expect(maskEmail('asha.rao@example.org')).toBe('a***@example.org');
  });
});

describe('emailInUse', () => {
  it('turns a unique violation of the email into 409 EMAIL_IN_USE and lets other errors through', () => {
    const taken = Object.assign(new Error('duplicate'), {
      code: '23505',
      constraint: 'uq_users_email',
    });
    expect(emailInUse(taken)).toBeInstanceOf(AppException);
    expect(emailInUse(taken)).toMatchObject({ status: 409, code: 'EMAIL_IN_USE' });
    const other = new Error('boom');
    expect(emailInUse(other)).toBe(other);
  });
});
