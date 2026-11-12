import type { SectionView } from './section.repository.js';
import { sectionResource } from './section.resource.js';

const view: SectionView = {
  id: '0192f3b0-0000-7000-8000-000000000001',
  created_at: new Date('2026-06-01T05:00:00Z'),
  created_by: null,
  updated_at: new Date('2026-06-02T05:00:00Z'),
  updated_by: null,
  version: 1,
  status: 1,
  society_id: '0192f3b0-0000-7000-8000-0000000000b1',
  institution_id: '0192f3b0-0000-7000-8000-0000000000b2',
  class_id: '0192f3b0-0000-7000-8000-0000000000c1',
  predefined_section_id: '0192f3b0-0000-7000-8000-0000000000d1',
  display_name: 'A',
  capacity: 40,
  predefined_code: 'A',
  predefined_name: 'A',
};

describe('sectionResource', () => {
  it('shows the section with its capacity, no class teacher and the students in it', () => {
    expect(sectionResource(view, new Map(), null, 12)).toMatchObject({
      id: view.id,
      classId: view.class_id,
      institutionId: view.institution_id,
      predefinedSection: { id: view.predefined_section_id, code: 'A', name: 'A' },
      displayName: 'A',
      capacity: 40,
      currentStudentCount: 12,
      classTeacher: null,
      status: 1,
      version: 1,
    });
  });

  it('shows no capacity as null', () => {
    expect(sectionResource({ ...view, capacity: null }, new Map(), null, 0).capacity).toBeNull();
  });

  it('shows the class teacher it is given', () => {
    const lead = { staffMemberId: 'staff-1', firstName: 'Meera', lastName: null };
    expect(sectionResource(view, new Map(), lead, 0).classTeacher).toEqual(lead);
  });
});
