import type { TimetableEntryWithSlot } from './timetable-entry.repository.js';
import { timetableEntryResource, type EntryNames } from './timetable-entry.resource.js';

const row: TimetableEntryWithSlot = {
  id: 'entry-1',
  created_at: new Date('2026-11-01T04:00:00.000Z'),
  created_by: null,
  updated_at: new Date('2026-11-02T04:00:00.000Z'),
  updated_by: null,
  version: 3,
  status: 1,
  society_id: 'society-1',
  institution_id: 'inst-1',
  academic_year_id: 'year-1',
  section_id: 'section-1',
  day_of_week: 2,
  time_slot_id: 'slot-1',
  is_break: false,
  subject_id: 'subject-1',
  staff_member_id: 'staff-1',
  period_no: 3,
  label: 'Period 3',
  start_time: '09:50:00',
  end_time: '10:30:00',
};

const names: EntryNames = {
  subjects: new Map([['subject-1', 'Maths']]),
  teachers: new Map([['staff-1', 'Asha Rao']]),
  sections: new Map([['section-1', { displayName: 'A', className: '5', classId: 'class-1' }]]),
};

describe('timetableEntryResource', () => {
  it('shows the period, the subject, the teacher and the section', () => {
    expect(timetableEntryResource(row, names, new Map())).toMatchObject({
      id: 'entry-1',
      institutionId: 'inst-1',
      sectionId: 'section-1',
      sectionName: 'A',
      className: '5',
      dayOfWeek: 2,
      timeSlot: {
        id: 'slot-1',
        periodNo: 3,
        label: 'Period 3',
        startTime: '09:50',
        endTime: '10:30',
      },
      isBreak: false,
      subject: { id: 'subject-1', name: 'Maths' },
      teacher: { id: 'staff-1', displayName: 'Asha Rao' },
      version: 3,
    });
  });

  it('shows a break with no subject and no teacher, and no section names where there are none', () => {
    const resource = timetableEntryResource(
      { ...row, is_break: true, subject_id: null, staff_member_id: null },
      { subjects: new Map(), teachers: new Map(), sections: new Map() },
      new Map(),
    );
    expect(resource).toMatchObject({
      isBreak: true,
      subject: null,
      teacher: null,
      sectionName: null,
      className: null,
    });
  });
});
