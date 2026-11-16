import type { Principal } from '../../common/auth/access-token-verifier.js';
import type { RoleCode } from '../../common/auth/roles.js';
import type { GrantDirectory, GuardedChild } from '../../platform/identity/index.js';
import { ChildAccess } from './child-access.js';

const child = (studentId: string, fields: Partial<GuardedChild> = {}): GuardedChild => ({
  studentId,
  societyId: 'soc-1',
  institutionId: 'ins-1',
  institutionName: 'Green Valley School',
  firstName: 'Diya',
  lastName: null,
  photoFileId: null,
  className: null,
  sectionName: null,
  childBlocked: false,
  studentsBlocked: false,
  ...fields,
});

const principal = (roleCode: RoleCode | null = 5): Principal => ({
  personId: 'person-1',
  sessionId: 'session-1',
  roleCode,
  societyId: null,
  clientType: 'mobile',
  viaSupportAccess: false,
});

const access = (children: GuardedChild[]) => {
  const guardedChildren = vi.fn<GrantDirectory['guardedChildren']>().mockResolvedValue(children);
  return {
    access: new ChildAccess({ guardedChildren } as unknown as GrantDirectory),
    guardedChildren,
  };
};

describe('ChildAccess', () => {
  it('names the one child in the tenant, with no Institution, and the child’s own Institution and Society', async () => {
    const { access: childAccess } = access([child('stu-1'), child('stu-2')]);
    await expect(childAccess.of(principal(), 'stu-2')).resolves.toEqual({
      institutionId: 'ins-1',
      societyId: 'soc-1',
      tenant: { personId: 'person-1', roleCode: 5, childIds: ['stu-2'] },
    });
  });

  it('is 404 for a child the caller does not guard', async () => {
    const { access: childAccess } = access([child('stu-1')]);
    await expect(childAccess.of(principal(), 'stu-9')).rejects.toMatchObject({ status: 404 });
  });

  it('is 423 SECTION_BLOCKED (students) when the child’s Institution has its students blocked', async () => {
    const { access: childAccess } = access([child('stu-1', { studentsBlocked: true })]);
    await expect(childAccess.of(principal(), 'stu-1')).rejects.toMatchObject({
      status: 423,
      code: 'SECTION_BLOCKED',
      options: { details: { section: 'students' } },
    });
  });

  it('is 403 CHILD_ACCESS_BLOCKED for a child blocked from the profile, and only that child', async () => {
    const { access: childAccess } = access([
      child('stu-1', { childBlocked: true }),
      child('stu-2'),
    ]);
    await expect(childAccess.of(principal(), 'stu-1')).rejects.toMatchObject({
      status: 403,
      code: 'CHILD_ACCESS_BLOCKED',
    });
    await expect(childAccess.of(principal(), 'stu-2')).resolves.toMatchObject({
      tenant: { childIds: ['stu-2'] },
    });
  });

  it('puts the Institution block before the child block, as the wider one', async () => {
    const { access: childAccess } = access([
      child('stu-1', { childBlocked: true, studentsBlocked: true }),
    ]);
    await expect(childAccess.of(principal(), 'stu-1')).rejects.toMatchObject({ status: 423 });
  });

  it('refuses a caller who is not acting as a parent, without reading any child', async () => {
    const { access: childAccess, guardedChildren } = access([child('stu-1')]);
    await expect(childAccess.of(principal(2), 'stu-1')).rejects.toMatchObject({ status: 403 });
    expect(guardedChildren).not.toHaveBeenCalled();
  });

  it('reads the children once for a request, and again for the next', async () => {
    const { access: childAccess, guardedChildren } = access([child('stu-1'), child('stu-2')]);
    const request = principal();
    await childAccess.of(request, 'stu-1');
    await childAccess.of(request, 'stu-2');
    expect(guardedChildren).toHaveBeenCalledTimes(1);
    await childAccess.of(principal(), 'stu-1');
    expect(guardedChildren).toHaveBeenCalledTimes(2);
  });
});
