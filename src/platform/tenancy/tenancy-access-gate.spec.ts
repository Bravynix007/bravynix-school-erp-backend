import type { Principal } from '../../common/auth/access-token-verifier.js';
import { BlockSection } from '../../common/auth/block-section.js';
import type { ActiveBlock } from './access-block.rules.js';
import type { RequestScope, ScopeService } from './scope.service.js';
import { TenancyAccessGate } from './tenancy-access-gate.js';

const principal = (overrides: Partial<Principal> = {}): Principal => ({
  personId: 'person-1',
  sessionId: 'session-1',
  roleCode: 2,
  societyId: 'society-1',
  clientType: 'mobile',
  viaSupportAccess: false,
  ...overrides,
});

const owners: ActiveBlock = { section: BlockSection.Owners, institutionId: null };
const staffOf = (institutionId: string): ActiveBlock => ({
  section: BlockSection.Staff,
  institutionId,
});
const studentsOf = (institutionId: string): ActiveBlock => ({
  section: BlockSection.Students,
  institutionId,
});

function build(blocks: ActiveBlock[] = [], reached: string[] = []) {
  const activeBlocks = vi.fn<ScopeService['activeBlocks']>().mockResolvedValue(blocks);
  const forPrincipal = vi.fn<ScopeService['forPrincipal']>().mockResolvedValue({
    institutions: reached.map((id) => ({ id, staffBlocked: false })),
  } as unknown as RequestScope);
  const gate = new TenancyAccessGate({ activeBlocks, forPrincipal } as unknown as ScopeService);
  return { gate, activeBlocks, forPrincipal };
}

describe('TenancyAccessGate', () => {
  it('does not look anything up for a caller with no Society', async () => {
    const { gate, activeBlocks } = build([owners]);
    expect(await gate.blockedSection(principal({ societyId: null, roleCode: 1 }))).toBeNull();
    expect(activeBlocks).not.toHaveBeenCalled();
  });

  describe('a Society Owner', () => {
    it('is stopped by an owners block, with the section named', async () => {
      expect(await build([owners]).gate.blockedSection(principal())).toBe(BlockSection.Owners);
    });

    it('carries on when only staff or students are blocked, or nothing', async () => {
      expect(await build().gate.blockedSection(principal())).toBeNull();
      const t = build([staffOf('i1'), studentsOf('i2')]);
      expect(await t.gate.blockedSection(principal())).toBeNull();
    });

    it('costs one read: the Institutions are not looked up', async () => {
      const t = build([owners]);
      await t.gate.blockedSection(principal());
      expect(t.forPrincipal).not.toHaveBeenCalled();
    });
  });

  describe('an Institution Admin', () => {
    const admin = principal({ roleCode: 3 });

    it('is stopped when every Institution they reach has its staff blocked', async () => {
      const shut = [staffOf('i1'), staffOf('i2')];
      expect(await build(shut, ['i1']).gate.blockedSection(admin)).toBe(BlockSection.Staff);
      expect(await build(shut, ['i1', 'i2']).gate.blockedSection(admin)).toBe(BlockSection.Staff);
    });

    it('carries on while one Institution is open', async () => {
      const t = build([staffOf('i1')], ['i1', 'i2']);
      expect(await t.gate.blockedSection(admin)).toBeNull();
    });

    it('is not stopped by an owners or students block', async () => {
      expect(await build([owners, studentsOf('i1')], ['i1']).gate.blockedSection(admin)).toBeNull();
    });

    it('is not stopped for reaching no Institution: there is nothing blocked to blame', async () => {
      expect(await build([staffOf('i1')], []).gate.blockedSection(admin)).toBeNull();
    });
  });

  it('leaves a parent to the per-child check, where a request names a child', async () => {
    expect(
      await build([studentsOf('i1')]).gate.blockedSection(principal({ roleCode: 5 })),
    ).toBeNull();
  });
});
