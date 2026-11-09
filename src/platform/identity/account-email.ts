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
export function emailChangedEmail(
  to: string,
  kind: 'old' | 'new',
  changedBy = 'a platform administrator',
): EmailMessage {
  return {
    to,
    template: `email-changed-${kind}`,
    subject: 'The email address of your BravyNix School ERP account was changed',
    text: [
      kind === 'old'
        ? `The email address of your account was changed by ${changedBy}. You can no longer sign in with this address.`
        : `This address is now the sign-in email of a BravyNix School ERP account, changed by ${changedBy}.`,
      '',
      kind === 'old'
        ? 'If you think this is a mistake, contact BravyNix support.'
        : 'Ask for a login code on the sign-in page to sign in. All earlier sessions have been ended.',
    ].join('\n'),
  };
}

/** Tells a person their staff access moved to another email address; their own account stays as it was. */
export function staffMovedEmail(to: string): EmailMessage {
  return {
    to,
    template: 'staff-access-moved',
    subject: 'Your staff access in BravyNix School ERP was moved to another email address',
    text: [
      'Your school moved your Teacher / Staff access to another email address. You can no longer sign in to the school with this address.',
      '',
      'Your other access, if any, is unchanged. If you think this is a mistake, contact your school.',
    ].join('\n'),
  };
}

/** Tells a person their Institution Admin access to an Institution was given or taken away. */
export function adminAccessEmail(
  to: string,
  kind: 'granted' | 'revoked',
  institutionName: string,
): EmailMessage {
  return {
    to,
    template: `admin-access-${kind}`,
    subject:
      kind === 'granted'
        ? `You are now an Admin of ${institutionName} on BravyNix School ERP`
        : `Your Admin access to ${institutionName} on BravyNix School ERP was removed`,
    text: [
      kind === 'granted'
        ? `You have been given Institution Admin access to ${institutionName}. Sign in as usual and choose the Admin role.`
        : `Your Institution Admin access to ${institutionName} was removed, and you have been signed out of the Admin role. Your other access, if any, is unchanged.`,
      '',
      'If you think this is a mistake, contact your school.',
    ].join('\n'),
    variables: { institution: institutionName },
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
