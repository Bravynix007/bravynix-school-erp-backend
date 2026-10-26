import type { EmailMessage } from '../email/email-sender.js';

/**
 * Welcome mail for a person who was added by email (PRD 5.2): they sign in with
 * their email and a code, so there is no password and no link. It names the
 * role and the Society, nothing else about the account.
 */
export function welcomeEmail(to: string, role: string, societyName: string | null): EmailMessage {
  const where = societyName === null ? '' : ` of ${societyName}`;
  return {
    to,
    template: 'welcome',
    subject: 'You have been added to BravyNix School ERP',
    text: [
      `You have been added as a ${role}${where} on BravyNix School ERP.`,
      '',
      'Sign in with this email address: ask for a login code on the sign-in page and enter it. There is no password.',
      'If you did not expect this, you can ignore this email.',
    ].join('\n'),
    variables: { role, society: societyName ?? '' },
  };
}

/** Tells a person their account was blocked, so they know to contact support rather than retry. */
export function accountBlockedEmail(to: string): EmailMessage {
  return {
    to,
    template: 'account-blocked',
    subject: 'Your BravyNix School ERP account has been blocked',
    text: [
      'Your account was blocked by a platform administrator, so you have been signed out and cannot sign in.',
      '',
      'If you think this is a mistake, contact BravyNix support.',
    ].join('\n'),
  };
}

/** Sent to the old and the new address when a person's email is changed, so neither is a surprise. */
export function emailChangedEmail(to: string, kind: 'old' | 'new'): EmailMessage {
  return {
    to,
    template: `email-changed-${kind}`,
    subject: 'The email address of your BravyNix School ERP account was changed',
    text: [
      kind === 'old'
        ? 'The email address of your account was changed by a platform administrator. You can no longer sign in with this address.'
        : 'This address is now the sign-in email of a BravyNix School ERP account, changed by a platform administrator.',
      '',
      kind === 'old'
        ? 'If you think this is a mistake, contact BravyNix support.'
        : 'Ask for a login code on the sign-in page to sign in. All earlier sessions have been ended.',
    ].join('\n'),
  };
}

/** Tells a Super Admin their authenticator was removed, so they know to set it up again at the next sign-in. */
export function authenticatorResetEmail(to: string): EmailMessage {
  return {
    to,
    template: 'authenticator-reset',
    subject: 'Your BravyNix School ERP authenticator was reset',
    text: [
      'Another Super Admin reset the authenticator app of your account, and you have been signed out of the console.',
      '',
      'At your next sign-in you will be asked to set up the authenticator app again.',
      'If you did not expect this, tell another Super Admin.',
    ].join('\n'),
  };
}
