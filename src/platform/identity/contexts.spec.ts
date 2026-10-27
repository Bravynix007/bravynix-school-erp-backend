import { findContext, mobileContexts, onlyContext } from './contexts.js';
import type { Grant } from './session.repository.js';

const grant = (
  roleCode: number,
  societyId: string | null,
  institutionId: string | null = null,
): Grant => ({
  roleCode,
  societyId,
  societyName: societyId === null ? null : `Name of ${societyId}`,
  institutionId,
});

const choice = (roleCode: number, societyId: string | null) => ({
  roleCode,
  societyId,
  societyName: societyId === null ? null : `Name of ${societyId}`,
  isBlocked: false,
});

describe('mobileContexts', () => {
  it('drops the Super Admin grant, which acts on the console only', () => {
    expect(mobileContexts([grant(1, null), grant(2, 'soc-1')])).toEqual([choice(2, 'soc-1')]);
  });

  it('makes one context for an Institution Admin of several Institutions in one Society', () => {
    expect(
      mobileContexts([
        grant(3, 'soc-1', 'ins-1'),
        grant(3, 'soc-1', 'ins-2'),
        grant(3, 'soc-2', 'ins-3'),
      ]),
    ).toEqual([choice(3, 'soc-1'), choice(3, 'soc-2')]);
  });

  it('names the Society of each context, so two Owner seats can be told apart', () => {
    expect(
      mobileContexts([grant(2, 'soc-1'), grant(2, 'soc-2')]).map((c) => c.societyName),
    ).toEqual(['Name of soc-1', 'Name of soc-2']);
  });

  it('keeps a Society Owner and an Institution Admin of the same Society apart', () => {
    expect(mobileContexts([grant(2, 'soc-1'), grant(3, 'soc-1', 'ins-1')])).toHaveLength(2);
  });
});

describe('onlyContext and findContext', () => {
  const contexts = [choice(2, 'soc-1')];

  it('starts a session only when there is exactly one context', () => {
    expect(onlyContext(contexts)).toEqual(contexts[0]);
    expect(onlyContext([])).toBeNull();
    expect(onlyContext([...contexts, choice(3, 'soc-2')])).toBeNull();
  });

  it('matches the role and the Society exactly', () => {
    expect(findContext(contexts, 2, 'soc-1')).toBe(contexts[0]);
    expect(findContext(contexts, 2, 'soc-2')).toBeUndefined();
    expect(findContext(contexts, 3, 'soc-1')).toBeUndefined();
    expect(findContext(contexts, 5, null)).toBeUndefined();
  });
});
