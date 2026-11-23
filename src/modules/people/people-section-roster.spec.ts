import type { Tx } from '../../platform/database/index.js';
import { PeopleSectionRoster } from './people-section-roster.js';
import type { StudentRepository } from './student.repository.js';

const tx = {} as Tx;

describe('PeopleSectionRoster', () => {
  it('passes the section, the day and the cut-off to the roll, and the enrolments to the lookups', async () => {
    const placedOn = vi.fn<StudentRepository['placedOn']>().mockResolvedValue([]);
    const namedByEnrolment = vi
      .fn<StudentRepository['namedByEnrolment']>()
      .mockResolvedValue(new Map());
    const guardianUsersByEnrolment = vi
      .fn<StudentRepository['guardianUsersByEnrolment']>()
      .mockResolvedValue(new Map());
    const roster = new PeopleSectionRoster({
      placedOn,
      namedByEnrolment,
      guardianUsersByEnrolment,
    } as unknown as StudentRepository);
    const cutOff = new Date('2026-11-17T04:00:00.000Z');
    await roster.on(tx, 'section-1', '2026-11-17', cutOff);
    await roster.studentsOf(tx, ['e1']);
    await roster.guardiansOf(tx, ['e1']);
    expect(placedOn).toHaveBeenCalledWith(tx, 'section-1', '2026-11-17', cutOff);
    expect(namedByEnrolment).toHaveBeenCalledWith(tx, ['e1']);
    expect(guardianUsersByEnrolment).toHaveBeenCalledWith(tx, ['e1']);
  });
});
