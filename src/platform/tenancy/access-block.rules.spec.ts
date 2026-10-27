import { BlockSection, SECTION_ROLES } from '../../common/auth/block-section.js';
import { RoleCode } from '../../common/auth/roles.js';
import { isStaffRole, staffBlockedIds, stoppingSection } from './access-block.rules.js';

describe('section to role mapping', () => {
  it('stops Owners with owners, Admins and Teachers and Staff with staff, parents with students', () => {
    expect(SECTION_ROLES[BlockSection.Owners]).toEqual([RoleCode.SocietyOwner]);
    expect(SECTION_ROLES[BlockSection.Staff]).toEqual([
      RoleCode.InstitutionAdmin,
      RoleCode.TeacherStaff,
    ]);
    expect(SECTION_ROLES[BlockSection.Students]).toEqual([RoleCode.StudentParent]);
  });

  it('never lists Super Admin: it cannot be blocked this way', () => {
    for (const roles of Object.values(SECTION_ROLES)) {
      expect(roles).not.toContain(RoleCode.SuperAdmin);
    }
  });

  it('knows the staff roles', () => {
    expect([1, 2, 3, 4, 5].filter(isStaffRole)).toEqual([3, 4]);
    expect(isStaffRole(null)).toBe(false);
  });
});

describe('staffBlockedIds', () => {
  it('keeps the Institutions with a staff block and nothing else', () => {
    const ids = staffBlockedIds([
      { section: BlockSection.Staff, institutionId: 'i1' },
      { section: BlockSection.Students, institutionId: 'i2' },
      { section: BlockSection.Owners, institutionId: null },
    ]);
    expect([...ids]).toEqual(['i1']);
  });
});

const staff = (institutionId: string) => ({ section: BlockSection.Staff, institutionId });

describe('stoppingSection', () => {
  it('stops a Teacher or Staff member like an Institution Admin: when no Institution is left open', () => {
    expect(stoppingSection(RoleCode.TeacherStaff, [staff('i1')], ['i1'])).toBe(BlockSection.Staff);
    expect(stoppingSection(RoleCode.TeacherStaff, [staff('i1')], ['i1', 'i2'])).toBeNull();
  });

  it('stops nobody who is not Owner or staff, and never a Super Admin', () => {
    const everything = [
      { section: BlockSection.Owners, institutionId: null },
      staff('i1'),
      { section: BlockSection.Students, institutionId: 'i1' },
    ];
    for (const role of [RoleCode.SuperAdmin, RoleCode.StudentParent, null]) {
      expect(stoppingSection(role, everything, ['i1'])).toBeNull();
    }
  });
});
