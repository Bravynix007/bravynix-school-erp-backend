import type { Tx } from '../../platform/database/index.js';
import type { ClassDirectory } from '../academic-setup/index.js';
import type { EventRepository, EventRow } from './event.repository.js';
import { HolidayCalendar } from './holiday-calendar.js';

const holiday = (id: string, title: string) => ({ id, title }) as EventRow;

function build(holidays: EventRow[], limits: Record<string, string[]> = {}) {
  const events = {
    holidaysForStudentsOn: vi
      .fn<EventRepository['holidaysForStudentsOn']>()
      .mockResolvedValue(holidays),
    classesOf: vi
      .fn<EventRepository['classesOf']>()
      .mockResolvedValue(new Map(Object.entries(limits))),
  };
  const classes = {
    ofPredefined: vi
      .fn<ClassDirectory['ofPredefined']>()
      .mockImplementation((_tx, ids) =>
        Promise.resolve(new Set(ids.includes('pre-8') ? ['class-8a', 'class-8b'] : ['class-12'])),
      ),
  };
  return {
    calendar: new HolidayCalendar(
      events as unknown as EventRepository,
      classes as unknown as ClassDirectory,
    ),
    events,
    classes,
  };
}

const tx = {} as Tx;

describe('HolidayCalendar.forClass', () => {
  it('is a school day when no holiday covers the date', async () => {
    const { calendar, events } = build([]);
    expect(await calendar.forClass(tx, 'inst-1', 'class-8a', '2026-11-17')).toBeUndefined();
    expect(events.classesOf).not.toHaveBeenCalled();
  });

  it('is a holiday for every class when the holiday names none', async () => {
    const { calendar } = build([holiday('e1', 'Diwali')]);
    expect(await calendar.forClass(tx, 'inst-1', 'class-8a', '2026-11-17')).toEqual({
      eventId: 'e1',
      title: 'Diwali',
    });
  });

  it('is a holiday for the classes made from the predefined classes it names, and for no other', async () => {
    const { calendar } = build([holiday('e1', 'Up to 8th')], { e1: ['pre-8'] });
    expect(await calendar.forClass(tx, 'inst-1', 'class-8b', '2026-11-17')).toEqual({
      eventId: 'e1',
      title: 'Up to 8th',
    });
    expect(await calendar.forClass(tx, 'inst-1', 'class-12', '2026-11-17')).toBeUndefined();
  });

  it('takes the earliest holiday that covers the class', async () => {
    const { calendar } = build([holiday('e1', 'Up to 8th'), holiday('e2', 'For all')], {
      e1: ['pre-8'],
    });
    expect(await calendar.forClass(tx, 'inst-1', 'class-12', '2026-11-17')).toEqual({
      eventId: 'e2',
      title: 'For all',
    });
    expect(await calendar.forClass(tx, 'inst-1', 'class-8a', '2026-11-17')).toEqual({
      eventId: 'e1',
      title: 'Up to 8th',
    });
  });
});
