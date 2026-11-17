import type { Tx } from '../../platform/database/index.js';
import type { GrantDirectory } from '../../platform/identity/index.js';
import type { ClassDirectory } from '../academic-setup/index.js';
import { PeopleEventPeople } from './people-event-people.js';
import type { StaffRepository } from './staff.repository.js';
import type { StudentRepository } from './student.repository.js';

const tx = {} as Tx;

function build() {
  const societyOwners = vi
    .fn<GrantDirectory['societyOwners']>()
    .mockResolvedValue([{ id: 'owner-1' }] as Awaited<ReturnType<GrantDirectory['societyOwners']>>);
  const adminUserIds = vi
    .fn<GrantDirectory['adminUserIds']>()
    .mockResolvedValue(['admin-1', 'owner-1']);
  const activeUserIds = vi
    .fn<StaffRepository['activeUserIds']>()
    .mockResolvedValue(['teacher-1', 'admin-1']);
  const guardianUserIds = vi
    .fn<StudentRepository['guardianUserIds']>()
    .mockResolvedValue(['parent-1']);
  const ofPredefined = vi
    .fn<ClassDirectory['ofPredefined']>()
    .mockResolvedValue(new Set(['class-1']));
  const people = new PeopleEventPeople(
    { societyOwners, adminUserIds } as unknown as GrantDirectory,
    { activeUserIds } as unknown as StaffRepository,
    { guardianUserIds } as unknown as StudentRepository,
    { ofPredefined } as unknown as ClassDirectory,
  );
  return {
    people,
    societyOwners,
    adminUserIds,
    activeUserIds,
    guardianUserIds,
    ofPredefined,
  };
}

describe('PeopleEventPeople', () => {
  it('names the Owners, the Admins and the Teachers and Staff of the Institution, each person once', async () => {
    const t = build();
    expect(await t.people.staffUserIds(tx, 'society-1', 'inst-1')).toEqual([
      'owner-1',
      'admin-1',
      'teacher-1',
    ]);
    expect(t.societyOwners).toHaveBeenCalledWith('society-1');
    expect(t.adminUserIds).toHaveBeenCalledWith('society-1', 'inst-1');
    expect(t.activeUserIds).toHaveBeenCalledWith(tx, 'inst-1');
  });

  it('names the guardians of the Institution, with no class limit for no predefined classes', async () => {
    const t = build();
    expect(await t.people.parentUserIds(tx, 'inst-1', [])).toEqual(['parent-1']);
    expect(t.ofPredefined).not.toHaveBeenCalled();
    expect(t.guardianUserIds).toHaveBeenCalledWith(tx, 'inst-1', null);
  });

  it('limits the guardians to the classes made from the predefined classes', async () => {
    const t = build();
    await t.people.parentUserIds(tx, null, ['p-1']);
    expect(t.ofPredefined).toHaveBeenCalledWith(tx, ['p-1']);
    expect(t.guardianUserIds).toHaveBeenCalledWith(tx, null, new Set(['class-1']));
  });
});
