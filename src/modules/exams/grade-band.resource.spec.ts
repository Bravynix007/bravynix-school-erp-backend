import type { GradeBandRow } from './grade-band.repository.js';
import { gradeBandResource } from './grade-band.resource.js';

const row: GradeBandRow = {
  id: 'band-1',
  created_at: new Date('2026-11-01T04:00:00.000Z'),
  created_by: null,
  updated_at: new Date('2026-11-02T04:00:00.000Z'),
  updated_by: null,
  version: 2,
  status: 1,
  society_id: 'society-1',
  institution_id: 'inst-1',
  name: 'A2',
  min_percentage: '81.00',
  max_percentage: '90.99',
  grade_point: '9.00',
  description: 'Excellent',
};

describe('gradeBandResource', () => {
  it('shows the percentages and the grade point as numbers and carries the stamps', () => {
    expect(gradeBandResource(row, new Map())).toMatchObject({
      id: 'band-1',
      institutionId: 'inst-1',
      name: 'A2',
      minPercentage: 81,
      maxPercentage: 90.99,
      gradePoint: 9,
      description: 'Excellent',
      status: 1,
      version: 2,
      createdAt: '2026-11-01T04:00:00.000Z',
      updatedAt: '2026-11-02T04:00:00.000Z',
    });
  });

  it('keeps an empty grade point empty', () => {
    expect(gradeBandResource({ ...row, grade_point: null }, new Map()).gradePoint).toBeNull();
  });
});
