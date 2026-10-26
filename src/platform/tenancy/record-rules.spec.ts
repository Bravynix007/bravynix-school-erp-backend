import {
  pauseColumns,
  requireActive,
  requirePausable,
  requireResumable,
  RESUME_COLUMNS,
  type TenantRootRow,
} from './record-rules.js';

const row = (overrides: Partial<TenantRootRow> = {}): TenantRootRow => ({
  version: 3,
  status: 1,
  access_paused_at: null,
  ...overrides,
});
const paused = new Date('2026-10-26T10:00:00.000Z');

describe('record rules', () => {
  it('refuses a deactivated record', () => {
    expect(() => requireActive(row())).not.toThrow();
    expect(() => requireActive(row({ status: 0 }))).toThrow(
      expect.objectContaining({ status: 409, code: 'INVALID_STATE' }),
    );
  });

  it('pauses only an active record that is not paused', () => {
    expect(() => requirePausable(row())).not.toThrow();
    for (const bad of [row({ access_paused_at: paused }), row({ status: 0 })]) {
      expect(() => requirePausable(bad)).toThrow(
        expect.objectContaining({ code: 'INVALID_STATE' }),
      );
    }
  });

  it('resumes only an active record that is paused', () => {
    expect(() => requireResumable(row({ access_paused_at: paused }))).not.toThrow();
    for (const bad of [row(), row({ status: 0, access_paused_at: paused })]) {
      expect(() => requireResumable(bad)).toThrow(
        expect.objectContaining({ code: 'INVALID_STATE' }),
      );
    }
  });

  it('sets the three pause columns together, and clears them together', () => {
    expect(pauseColumns('admin', paused, 'Dues')).toEqual({
      access_paused_at: paused,
      access_paused_by: 'admin',
      access_pause_reason: 'Dues',
    });
    expect(RESUME_COLUMNS).toEqual({
      access_paused_at: null,
      access_paused_by: null,
      access_pause_reason: null,
    });
  });
});
