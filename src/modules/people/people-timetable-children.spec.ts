import type { Tx } from '../../platform/database/index.js';
import { PeopleTimetableChildren } from './people-timetable-children.js';
import type { StudentRepository } from './student.repository.js';

const tx = {} as Tx;

function build(open?: { section_id: string }) {
  const openPlacement = vi
    .fn<StudentRepository['openPlacement']>()
    .mockResolvedValue(open as Awaited<ReturnType<StudentRepository['openPlacement']>>);
  return {
    children: new PeopleTimetableChildren({ openPlacement } as unknown as StudentRepository),
    openPlacement,
  };
}

describe('PeopleTimetableChildren', () => {
  it('names the section a child sits in now', async () => {
    const t = build({ section_id: 'section-1' });
    expect(await t.children.currentSectionId(tx, 'child-1')).toBe('section-1');
    expect(t.openPlacement).toHaveBeenCalledWith(tx, 'child-1');
  });

  it('names none for a child with no open placement', async () => {
    expect(await build().children.currentSectionId(tx, 'child-1')).toBeUndefined();
  });
});
