import { otpEmail } from './otp-email.js';

describe('otpEmail', () => {
  const message = otpEmail('asha@example.com', '042913');

  it('carries the code and the life in the text, to the right address', () => {
    expect(message.to).toBe('asha@example.com');
    expect(message.template).toBe('otp');
    expect(message.text).toContain('042913');
    expect(message.text).toContain('10 minutes');
  });

  it('keeps the code out of the subject, which shows in notifications and logs', () => {
    expect(message.subject).not.toContain('042913');
  });

  it('tells the reader to ignore it if they did not ask, and never to share it', () => {
    expect(message.text).toMatch(/did not ask/);
    expect(message.text).toMatch(/never ask you to share/);
  });
});
