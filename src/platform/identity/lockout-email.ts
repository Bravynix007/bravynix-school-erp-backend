import type { EmailMessage } from '../email/email-sender.js';

function durationText(lockSeconds: number): string {
  return lockSeconds >= 3600
    ? `${String(Math.round(lockSeconds / 3600))} hours`
    : `${String(Math.round(lockSeconds / 60))} minutes`;
}

/**
 * Tells a person that their sign-in is locked after five wrong codes. It
 * names the length of the lock only: no code, no address of the caller. Sent
 * to a registered email only, so the mail itself does not reveal that an
 * address has an account to someone who does not own it.
 */
export function lockoutEmail(to: string, lockSeconds: number): EmailMessage {
  const duration = durationText(lockSeconds);
  return {
    to,
    template: 'login-lockout',
    subject: 'Sign-in to your BravyNix School ERP account is paused',
    text: [
      `Someone entered a wrong login code for your account five times, so sign-in is paused for ${duration}.`,
      '',
      'If this was you, wait and ask for a new code afterwards.',
      'If it was not, you do not need to do anything: nobody can sign in without a code sent to this email.',
      'If this keeps happening, tell your school office.',
    ].join('\n'),
    variables: { duration },
  };
}

/**
 * Tells a Super Admin that the console is locked after too many wrong
 * authenticator codes. Sent only after the person proved the mailbox with a
 * correct email code, so it tells nobody else anything.
 */
export function authenticatorLockoutEmail(to: string, lockSeconds: number): EmailMessage {
  const duration = durationText(lockSeconds);
  return {
    to,
    template: 'authenticator-lockout',
    subject: 'Console sign-in to BravyNix School ERP is paused',
    text: [
      `Too many wrong authenticator codes were entered for your account, so console sign-in is paused for ${duration}.`,
      '',
      'If this was you, wait and sign in again afterwards.',
      'If it was not, someone may have access to your mailbox: change its password and tell another Super Admin.',
    ].join('\n'),
    variables: { duration },
  };
}
