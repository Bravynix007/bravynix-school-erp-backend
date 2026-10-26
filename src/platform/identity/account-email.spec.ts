import {
  accountBlockedEmail,
  authenticatorResetEmail,
  emailChangedEmail,
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
});
