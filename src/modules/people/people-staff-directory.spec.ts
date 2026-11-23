import type { Tx } from '../../platform/database/index.js';
import { PeopleStaffDirectory } from './people-staff-directory.js';
import type { StaffRepository, StaffRow } from './staff.repository.js';

const tx = {} as Tx;

function build(found?: Partial<StaffRow>) {
  const activeOfUser = vi
    .fn<StaffRepository['activeOfUser']>()
    .mockResolvedValue(found as StaffRow | undefined);
  const namesOf = vi
    .fn<StaffRepository['namesOf']>()
    .mockResolvedValue(
      new Map([['staff-1', { id: 'staff-1', first_name: 'Asha', last_name: 'Rao' }]]),
    );
  const namesForParent = vi
    .fn<StaffRepository['namesForParent']>()
    .mockResolvedValue(
      new Map([['staff-1', { id: 'staff-1', first_name: 'Asha', last_name: null }]]),
    );
  const directory = new PeopleStaffDirectory({
    activeOfUser,
    namesOf,
    namesForParent,
  } as unknown as StaffRepository);
  return { directory, activeOfUser, namesOf, namesForParent };
}

describe('PeopleStaffDirectory.ownRecord', () => {
  it('says who the caller is and where they are at home', async () => {
    expect(
      await build({ id: 'staff-1', home_institution_id: 'inst-1' }).directory.ownRecord(
        tx,
        'person-1',
      ),
    ).toEqual({ staffMemberId: 'staff-1', homeInstitutionId: 'inst-1' });
  });

  it('says nothing for a person who is not staff', async () => {
    const t = build();
    expect(await t.directory.ownRecord(tx, 'person-1')).toBeUndefined();
    expect(t.activeOfUser).toHaveBeenCalledWith(tx, 'person-1');
  });
});

describe('PeopleStaffDirectory names', () => {
  it('writes first and last name, from the scope the caller has', async () => {
    const t = build();
    expect(await t.directory.names(tx, ['staff-1'])).toEqual(new Map([['staff-1', 'Asha Rao']]));
    expect(t.namesOf).toHaveBeenCalledWith(tx, ['staff-1']);
  });

  it('reads a parent’s names through the names-only function, and drops a missing last name', async () => {
    const t = build();
    expect(await t.directory.namesForParent(tx, ['staff-1'])).toEqual(
      new Map([['staff-1', 'Asha']]),
    );
    expect(t.namesForParent).toHaveBeenCalledWith(tx, ['staff-1']);
    expect(t.namesOf).not.toHaveBeenCalled();
  });
});
