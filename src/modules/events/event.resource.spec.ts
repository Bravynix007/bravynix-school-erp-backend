import { RoleCode } from '../../common/auth/roles.js';
import type { EventRow } from './event.repository.js';
import { eventResource } from './event.resource.js';

const row: EventRow = {
  id: 'event-1',
  created_at: new Date('2026-11-01T00:00:00.000Z'),
  created_by: 'owner-1',
  updated_at: new Date('2026-11-02T00:00:00.000Z'),
  updated_by: 'owner-1',
  version: 3,
  status: 1,
  society_id: 'society-1',
  scope: 2,
  institution_id: 'inst-1',
  title: 'Sports Day',
  description: null,
  venue: 'Ground',
  start_date: '2026-12-10',
  end_date: '2026-12-10',
  duration_label: '1 Day Holiday',
  audience: 2,
  preset_image_code: 'sports',
  image_file_id: null,
  is_holiday: true,
  holiday_type: 3,
  holiday_for_students: true,
  holiday_for_staff: false,
};

const asha = { id: 'owner-1', displayName: 'Asha Rao', roleName: 'Society Owner' };
const people = new Map([['owner-1', asha]]);
const none = new Map<string, string>();

describe('eventResource', () => {
  it('shows the event with its classes, version and who made it', () => {
    expect(eventResource(row, ['class-1'], RoleCode.SocietyOwner, people, none)).toEqual({
      id: 'event-1',
      title: 'Sports Day',
      description: null,
      venue: 'Ground',
      startDate: '2026-12-10',
      endDate: '2026-12-10',
      durationLabel: '1 Day Holiday',
      audience: 2,
      scope: 2,
      institutionId: 'inst-1',
      presetImageCode: 'sports',
      image: null,
      isHoliday: true,
      holidayType: 3,
      holidayForStudents: true,
      holidayForStaff: false,
      holidayPredefinedClassIds: ['class-1'],
      canEdit: true,
      status: 1,
      version: 3,
      createdAt: '2026-11-01T00:00:00.000Z',
      updatedAt: '2026-11-02T00:00:00.000Z',
      createdBy: asha,
      updatedBy: asha,
    });
  });

  it('says whether the caller sees Edit: an Admin for an Institution event, not the Society’s', () => {
    expect(eventResource(row, [], RoleCode.InstitutionAdmin, people, none).canEdit).toBe(true);
    expect(
      eventResource(
        { ...row, scope: 1, institution_id: null },
        [],
        RoleCode.InstitutionAdmin,
        people,
        none,
      ).canEdit,
    ).toBe(false);
    expect(eventResource(row, [], RoleCode.TeacherStaff, people, none).canEdit).toBe(false);
  });

  it('shows the own picture with its public address, and none when its file is gone', () => {
    const own = { ...row, preset_image_code: null, image_file_id: 'file-1' };
    const urls = new Map([['file-1', 'https://files.test/public/s/i/10/abc']]);
    expect(eventResource(own, [], RoleCode.TeacherStaff, people, urls).image).toEqual({
      id: 'file-1',
      url: 'https://files.test/public/s/i/10/abc',
    });
    expect(eventResource(own, [], RoleCode.TeacherStaff, people, none).image).toBeNull();
  });
});
