import type { DocumentRow } from './document.repository.js';
import { documentResource } from './document.resource.js';

const at = new Date('2026-11-10T04:30:00.000Z');
const row = (overrides: Partial<DocumentRow> = {}): DocumentRow =>
  ({
    id: 'doc-1',
    created_at: at,
    created_by: 'admin-1',
    updated_at: at,
    updated_by: null,
    status: 1,
    society_id: 'society-1',
    institution_id: 'institution-1',
    owner_type: 2,
    staff_member_id: 'staff-1',
    title: 'Appointment letter',
    file_id: 'file-1',
    ...overrides,
  }) as DocumentRow;
const file = { id: 'file-1', contentType: 'application/pdf', sizeBytes: 10, fileName: 'a.pdf' };

describe('documentResource', () => {
  it('shows the owner, the title, the file and the author stamps, and nothing of the Institution', () => {
    const people = new Map([
      ['admin-1', { id: 'admin-1', displayName: 'Asha', roleName: 'Institution Admin' }],
    ]);
    expect(documentResource(row(), file, people)).toEqual({
      id: 'doc-1',
      ownerType: 'staff',
      staffMemberId: 'staff-1',
      title: 'Appointment letter',
      file,
      createdBy: { id: 'admin-1', displayName: 'Asha', roleName: 'Institution Admin' },
      createdAt: '2026-11-10T04:30:00.000Z',
      updatedBy: { id: null, displayName: 'System', roleName: null },
      updatedAt: '2026-11-10T04:30:00.000Z',
    });
  });

  it('refuses a row with no staff owner: the table never holds one', () => {
    expect(() => documentResource(row({ staff_member_id: null }), file, new Map())).toThrow(
      'no staff owner',
    );
  });
});
