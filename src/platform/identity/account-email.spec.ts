import {
  accountBlockedEmail,
  authenticatorResetEmail,
  emailChangedEmail,
  guardianMovedEmail,
  guardianRemovedEmail,
  welcomeEmail,
} from './account-email.js';

describe('account mails', () => {
  it('welcomes a person to the role and Society, with no password and no link', () => {
    const mail = welcomeEmail('asha@example.com', 'Society Owner', 'Sunrise Trust');
    expect(mail).toMatchObject({ to: 'asha@example.com', template: 'welcome' });
    expect(mail.text).toContain('Society Owner of Sunrise Trust');
    expect(mail.text).not.toMatch(/https?:/);
    expect(welcomeEmail('a@example.com', 'Super Admin', null).text).toContain(
      'as a Super Admin on',
    );
  });

  it('tells the old and the new address apart', () => {
    expect(emailChangedEmail('old@example.com', 'old')).toMatchObject({
      template: 'email-changed-old',
    });
    expect(emailChangedEmail('new@example.com', 'new')).toMatchObject({
      template: 'email-changed-new',
    });
    expect(emailChangedEmail('old@example.com', 'old').text).toContain('no longer sign in');
  });

  it('names a block and an authenticator reset without any code', () => {
    expect(accountBlockedEmail('a@example.com')).toMatchObject({ template: 'account-blocked' });
    expect(authenticatorResetEmail('a@example.com')).toMatchObject({
      template: 'authenticator-reset',
    });
  });

  it('tells a guardian their parent access moved, or was removed, and keeps the account out of it', () => {
    expect(guardianMovedEmail('p@example.com')).toMatchObject({
      to: 'p@example.com',
      template: 'guardian-access-moved',
    });
    expect(guardianRemovedEmail('p@example.com')).toMatchObject({
      to: 'p@example.com',
      template: 'guardian-access-removed',
    });
    for (const mail of [
      guardianMovedEmail('p@example.com'),
      guardianRemovedEmail('p@example.com'),
    ]) {
      expect(mail.text).toContain('Your other access, if any, is unchanged');
      expect(mail.text).not.toMatch(/https?:/);
    }
  });
});
