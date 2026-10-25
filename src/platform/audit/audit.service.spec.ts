import { buildAuditRow, AuditOutcome } from './audit.service.js';

const NOW = new Date('2026-10-25T10:00:00.000Z');
const ID = '0192f6b0-11aa-7c3d-9e10-5a6b7c8d9e0f';
const context = {
  requestId: '0192f6b0-11ab-7a00-8c11-6b7c8d9e0f10',
  language: 'en' as const,
  personId: '0192f3a1-0b2c-7d3e-8f40-1a2b3c4d5e6f',
  societyId: '0192f3b0-2c3d-7e4f-9a50-2b3c4d5e6f70',
  roleCode: 2,
  displayName: 'Asha Rao',
  ipAddress: '203.0.113.7',
  userAgent: 'BravyNixApp/1.0 (Android 15)',
};

describe('buildAuditRow', () => {
  it('takes the actor, tenant and request details from the request', () => {
    const row = buildAuditRow(
      { action: 'student.update', institutionId: null, entityType: 'student' },
      context,
      NOW,
      ID,
    );
    expect(row).toMatchObject({
      id: ID,
      created_at: NOW,
      society_id: context.societyId,
      actor_user_id: context.personId,
      actor_role_code: 2,
      actor_display_name: 'Asha Rao',
      request_id: context.requestId,
      ip_address: '203.0.113.7',
      user_agent: 'BravyNixApp/1.0 (Android 15)',
      outcome: AuditOutcome.Success,
      via_support_access: false,
      institution_id: null,
    });
  });

  it('lets an entry name its own actor, as a login must', () => {
    const row = buildAuditRow(
      {
        action: 'auth.login',
        institutionId: null,
        societyId: null,
        actor: { userId: 'u-1', roleCode: 4, displayName: 'Ravi' },
      },
      { requestId: context.requestId, language: 'en' },
      NOW,
      ID,
    );
    expect(row).toMatchObject({
      society_id: null,
      actor_user_id: 'u-1',
      actor_role_code: 4,
      actor_display_name: 'Ravi',
    });
  });

  it('uses null, not the caller’s Society, when the entry says it has none', () => {
    const row = buildAuditRow(
      { action: 'platform.society.create', institutionId: null, societyId: null },
      context,
      NOW,
      ID,
    );
    expect(row.society_id).toBeNull();
  });

  it('leaves the actor empty for a system job', () => {
    const row = buildAuditRow(
      { action: 'jobs.partition_upkeep', institutionId: null },
      undefined,
      NOW,
      ID,
    );
    expect(row).toMatchObject({
      actor_user_id: null,
      actor_role_code: null,
      actor_display_name: null,
      request_id: null,
      ip_address: null,
      user_agent: null,
      society_id: null,
    });
  });

  it('records changed fields only, with secrets removed', () => {
    const row = buildAuditRow(
      {
        action: 'student.update',
        institutionId: null,
        before: { firstName: 'Diya', otp: '1' },
        after: { firstName: 'Diya R', otp: '2' },
      },
      context,
      NOW,
      ID,
    );
    expect(row.old_values).toBe('{"firstName":"Diya"}');
    expect(row.new_values).toBe('{"firstName":"Diya R"}');
  });

  it.each([
    '',
    'Login',
    'login',
    'auth.',
    'auth..login',
    'auth.Login',
    '1auth.login',
    `a.${'b'.repeat(60)}`,
  ])('refuses the action %j', (action) => {
    expect(() => buildAuditRow({ action, institutionId: null }, context, NOW, ID)).toThrow(
      /Invalid audit action/,
    );
  });

  it('accepts the action names of API design 20.3', () => {
    for (const action of [
      'auth.login',
      'auth.context_switch',
      'access.grant',
      'fees.receipt.cancel',
      'identity.reveal',
      'file.download',
    ]) {
      expect(buildAuditRow({ action, institutionId: null }, context, NOW, ID).action).toBe(action);
    }
  });

  it('refuses a null Society inside a tenant request, except for person and platform actions (S2)', () => {
    // The tenant would never see it in its own audit view.
    expect(() =>
      buildAuditRow(
        { action: 'student.update', societyId: null, institutionId: null },
        context,
        NOW,
        ID,
      ),
    ).toThrow(/needs a Society/);
    for (const action of ['auth.logout', 'auth.login', 'platform.society.create']) {
      const row = buildAuditRow({ action, societyId: null, institutionId: null }, context, NOW, ID);
      expect(row.society_id).toBeNull();
    }
    // Outside a tenant request (a Super Admin, a job) a null Society is fine for any action.
    const { societyId: _societyId, ...platformContext } = context;
    expect(
      buildAuditRow(
        { action: 'society.create', societyId: null, institutionId: null },
        platformContext,
        NOW,
        ID,
      ).society_id,
    ).toBeNull();
  });

  it('refuses a reason over 500 characters', () => {
    expect(() =>
      buildAuditRow(
        { action: 'support.start', institutionId: null, reason: 'x'.repeat(501) },
        context,
        NOW,
        ID,
      ),
    ).toThrow(/reason/);
  });

  it('drops an address that is not an IP, and cleans and cuts the user agent and name', () => {
    const row = buildAuditRow(
      { action: 'auth.logout', institutionId: null },
      {
        ...context,
        ipAddress: 'not-an-ip',
        userAgent: `agent\r\nX-Injected: 1${'z'.repeat(400)}`,
        displayName: `Asha\nRao${'y'.repeat(300)}`,
      },
      NOW,
      ID,
    );
    expect(row.ip_address).toBeNull();
    expect(row.user_agent).toHaveLength(300);
    expect(row.user_agent).not.toMatch(/[\r\n]/);
    expect(row.actor_display_name).toHaveLength(200);
    expect(row.actor_display_name).not.toMatch(/[\r\n]/);
  });

  it('accepts an IPv6 address', () => {
    const row = buildAuditRow(
      { action: 'auth.logout', institutionId: null },
      { ...context, ipAddress: '2001:db8::1' },
      NOW,
      ID,
    );
    expect(row.ip_address).toBe('2001:db8::1');
  });
});
