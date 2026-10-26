import { canActAs, mobileContexts, onlyContext } from './contexts.js';
import type { Grant } from './session.repository.js';

const grant = (
  roleCode: number,
  societyId: string | null,
  institutionId: string | null = null,
): Grant => ({
  roleCode,
  societyId,
  institutionId,
});

describe('mobileContexts', () => {
  it('drops the Super Admin grant, which acts on the console only', () => {
    expect(mobileContexts([grant(1, null), grant(2, 'soc-1')])).toEqual([
      { roleCode: 2, societyId: 'soc-1' },
    ]);
  });

  it('makes one context for an Institution Admin of several Institutions in one Society', () => {
    expect(
      mobileContexts([
        grant(3, 'soc-1', 'ins-1'),
        grant(3, 'soc-1', 'ins-2'),
        grant(3, 'soc-2', 'ins-3'),
      ]),
    ).toEqual([
      { roleCode: 3, societyId: 'soc-1' },
      { roleCode: 3, societyId: 'soc-2' },
    ]);
  });

  it('keeps a Society Owner and an Institution Admin of the same Society apart', () => {
    expect(mobileContexts([grant(2, 'soc-1'), grant(3, 'soc-1', 'ins-1')])).toHaveLength(2);
  });
});

describe('onlyContext and canActAs', () => {
  const contexts = [{ roleCode: 2, societyId: 'soc-1' }];

  it('starts a session only when there is exactly one context', () => {
    expect(onlyContext(contexts)).toEqual(contexts[0]);
    expect(onlyContext([])).toBeNull();
    expect(onlyContext([...contexts, { roleCode: 3, societyId: 'soc-2' }])).toBeNull();
  });

  it('matches the role and the Society exactly', () => {
    expect(canActAs(contexts, 2, 'soc-1')).toBe(true);
    expect(canActAs(contexts, 2, 'soc-2')).toBe(false);
    expect(canActAs(contexts, 3, 'soc-1')).toBe(false);
    expect(canActAs(contexts, 5, null)).toBe(false);
  });
});
