import type { AuthorRef } from '../../common/http/author-stamps.js';
import type { ClassView } from './class.repository.js';
import { classResource } from './class.resource.js';

const view: ClassView = {
  id: '0192f3b0-0000-7000-8000-000000000001',
  created_at: new Date('2026-06-01T05:00:00Z'),
  created_by: '0192f3b0-0000-7000-8000-0000000000aa',
  updated_at: new Date('2026-06-02T05:00:00Z'),
  updated_by: '0192f3b0-0000-7000-8000-0000000000ab',
  version: 2,
  status: 1,
  society_id: '0192f3b0-0000-7000-8000-0000000000b1',
  institution_id: '0192f3b0-0000-7000-8000-0000000000b2',
  predefined_class_id: '0192f3b0-0000-7000-8000-0000000000c1',
  class_category_id: '0192f3b0-0000-7000-8000-0000000000c2',
  stream_name: 'PCMC',
  display_name: 'PUC 1st Year PCMC',
  code: null,
  predefined_code: 'PUC1',
  predefined_name: 'PUC 1st Year',
  category_code: 'PRE_UNIVERSITY',
  category_name: 'Pre-University',
  section_count: 3,
};

describe('classResource', () => {
  it('shows the class under its API names, with the master entries it is made from and the section count', () => {
    const people = new Map<string, AuthorRef>([
      [
        view.created_by!,
        { id: view.created_by, displayName: 'Asha Rao', roleName: 'Society Owner' },
      ],
    ]);
    expect(classResource(view, people)).toMatchObject({
      id: view.id,
      institutionId: view.institution_id,
      predefinedClass: { id: view.predefined_class_id, code: 'PUC1', name: 'PUC 1st Year' },
      category: { id: view.class_category_id, code: 'PRE_UNIVERSITY', name: 'Pre-University' },
      streamName: 'PCMC',
      displayName: 'PUC 1st Year PCMC',
      code: null,
      sectionCount: 3,
      status: 1,
      version: 2,
      createdBy: { id: view.created_by, displayName: 'Asha Rao', roleName: 'Society Owner' },
      createdAt: '2026-06-01T05:00:00.000Z',
      updatedAt: '2026-06-02T05:00:00.000Z',
    });
  });
});
