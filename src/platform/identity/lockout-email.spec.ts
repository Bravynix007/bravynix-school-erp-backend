import { authenticatorLockoutEmail, lockoutEmail } from './lockout-email.js';

describe('lockoutEmail', () => {
  it('names a 30 minute lock in minutes and a 24 hour lock in hours', () => {
    expect(lockoutEmail('asha@example.com', 1800).text).toContain('paused for 30 minutes');
    expect(lockoutEmail('asha@example.com', 86400).text).toContain('paused for 24 hours');
  });

  it('goes to the right address with its own template and no code', () => {
    const message = lockoutEmail('asha@example.com', 1800);
    expect(message.to).toBe('asha@example.com');
    expect(message.template).toBe('login-lockout');
    expect(message.text).not.toMatch(/\d{6}/);
  });

  it('tells the reader nothing is needed if it was not them', () => {
    expect(lockoutEmail('asha@example.com', 1800).text).toMatch(
      /not, you do not need to do anything/,
    );
  });
});

describe('authenticatorLockoutEmail', () => {
  it('names the 24 hour lock, goes to the address and carries no code', () => {
    const message = authenticatorLockoutEmail('root@example.com', 86400);
    expect(message).toMatchObject({ to: 'root@example.com', template: 'authenticator-lockout' });
    expect(message.text).toContain('paused for 24 hours');
    expect(message.text).not.toMatch(/\d{6}/);
  });
});
