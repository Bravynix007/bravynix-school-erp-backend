import { timeSlotResource } from './time-slot.resource.js';
import type { TimeSlotRow } from './time-slot.repository.js';

const row: TimeSlotRow = {
  id: 'slot-1',
  created_at: new Date('2026-11-01T04:00:00.000Z'),
  created_by: null,
  updated_at: new Date('2026-11-02T04:00:00.000Z'),
  updated_by: null,
  version: 2,
  status: 1,
  society_id: 'society-1',
  institution_id: 'inst-1',
  academic_year_id: 'year-1',
  period_no: 3,
  label: 'Period 3',
  start_time: '09:50:00',
  end_time: '10:30:00',
  is_break: false,
};

describe('timeSlotResource', () => {
  it('shows the times as HH:MM and carries the stamps', () => {
    expect(timeSlotResource(row, new Map())).toMatchObject({
      id: 'slot-1',
      institutionId: 'inst-1',
      academicYearId: 'year-1',
      periodNo: 3,
      label: 'Period 3',
      startTime: '09:50',
      endTime: '10:30',
      isBreak: false,
      status: 1,
      version: 2,
      createdAt: '2026-11-01T04:00:00.000Z',
      updatedAt: '2026-11-02T04:00:00.000Z',
    });
  });
});
