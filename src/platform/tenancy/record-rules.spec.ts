import { requireActive, type TenantRootRow } from './record-rules.js';

const row = (overrides: Partial<TenantRootRow> = {}): TenantRootRow => ({
  version: 3,
  status: 1,
  ...overrides,
});

describe('record rules', () => {
  it('refuses a deactivated record', () => {
    expect(() => requireActive(row())).not.toThrow();
    expect(() => requireActive(row({ status: 0 }))).toThrow(
      expect.objectContaining({ status: 409, code: 'INVALID_STATE' }),
    );
  });
});
