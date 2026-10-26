import type { EmailMessage } from '../email/email-sender.js';

/**
 * Tells a person that their sign-in is locked after five wrong codes. It
 * names the length of the lock only: no code, no address of the caller. Sent
 * to a registered email only, so the mail itself does not reveal that an
 * address has an account to someone who does not own it.
 */
export function lockoutEmail(to: string, lockSeconds: number): EmailMessage {
  const duration =
    lockSeconds >= 3600
      ? `${String(Math.round(lockSeconds / 3600))} hours`
      : `${String(Math.round(lockSeconds / 60))} minutes`;
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
