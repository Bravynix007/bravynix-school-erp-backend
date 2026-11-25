import type { Tx } from '../../platform/database/index.js';
import { AcademicYearDirectory } from './academic-year-directory.js';
import type { AcademicYearRepository, AcademicYearRow } from './academic-year.repository.js';

const tx = {} as Tx;
const year = (overrides: Partial<AcademicYearRow> = {}) =>
  ({ id: 'year-1', institution_id: 'institution-1', status: 1, ...overrides }) as AcademicYearRow;

const build = (found?: AcademicYearRow) => {
  const find = vi.fn<AcademicYearRepository['find']>().mockResolvedValue(found);
  const currentOf = vi.fn<AcademicYearRepository['currentOf']>().mockResolvedValue(found);
  const overlapping = vi.fn<AcademicYearRepository['overlapping']>().mockResolvedValue(found);
  return {
    directory: new AcademicYearDirectory({
      find,
      currentOf,
      overlapping,
    } as unknown as AcademicYearRepository),
    find,
    currentOf,
    overlapping,
  };
};

describe('AcademicYearDirectory', () => {
  describe('openYear', () => {
    it('says whether a year of the Institution is open, and when it starts and ends', async () => {
      const found = year({ start_date: '2026-06-01', end_date: '2027-03-31' });
      await expect(build(found).directory.openYear(tx, 'year-1', 'institution-1')).resolves.toEqual(
        {
          open: true,
          startDate: '2026-06-01',
          endDate: '2027-03-31',
        },
      );
      await expect(
        build({ ...found, status: 0 }).directory.openYear(tx, 'year-1', 'institution-1'),
      ).resolves.toMatchObject({ open: false });
    });

    it('is undefined for a year that is not there, and for one of another Institution', async () => {
      for (const found of [undefined, year({ institution_id: 'institution-2' })]) {
        await expect(
          build(found).directory.openYear(tx, 'year-1', 'institution-1'),
        ).resolves.toBeUndefined();
      }
    });
  });

  describe('requireActive', () => {
    it('passes for an active year of the Institution', async () => {
      const t = build(year());
      await expect(
        t.directory.requireActive(tx, 'year-1', 'institution-1', 'academicYearId'),
      ).resolves.toBeUndefined();
      expect(t.find).toHaveBeenCalledWith(tx, 'year-1');
    });

    it('is 404 for a year that is not there, and for one of another Institution', async () => {
      for (const found of [undefined, year({ institution_id: 'institution-2' })]) {
        await expect(
          build(found).directory.requireActive(tx, 'year-1', 'institution-1', 'academicYearId'),
        ).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
      }
    });

    it('is 422 REFERENCE_INACTIVE on the field for a deactivated year', async () => {
      await expect(
        build(year({ status: 0 })).directory.requireActive(
          tx,
          'year-1',
          'institution-1',
          'academicYearId',
        ),
      ).rejects.toMatchObject({
        status: 422,
        code: 'REFERENCE_INACTIVE',
        options: { errors: [{ field: 'academicYearId', code: 'REFERENCE_INACTIVE' }] },
      });
    });
  });

  describe('currentId', () => {
    it('is the current year of the Institution, or null when there is none', async () => {
      const t = build(year({ id: 'year-9' }));
      expect(await t.directory.currentId(tx, 'institution-1')).toBe('year-9');
      expect(t.currentOf).toHaveBeenCalledWith(tx, 'institution-1');
      expect(await build().directory.currentId(tx, 'institution-1')).toBeNull();
    });
  });

  describe('requireCurrentId', () => {
    it('is the current year of the Institution', async () => {
      expect(
        await build(year({ id: 'year-9' })).directory.requireCurrentId(tx, 'institution-1'),
      ).toBe('year-9');
    });

    it('is 422 CURRENT_YEAR_REQUIRED when the Institution has none', async () => {
      await expect(build().directory.requireCurrentId(tx, 'institution-1')).rejects.toMatchObject({
        status: 422,
        code: 'CURRENT_YEAR_REQUIRED',
      });
    });
  });

  describe('overlapping', () => {
    it('is the year with a day in the span, with its first and last day', async () => {
      const t = build(year({ id: 'year-3', start_date: '2026-06-01', end_date: '2027-03-31' }));
      expect(
        await t.directory.overlapping(tx, 'institution-1', '2026-11-01', '2026-11-30'),
      ).toEqual({
        id: 'year-3',
        startDate: '2026-06-01',
        endDate: '2027-03-31',
      });
      expect(t.overlapping).toHaveBeenCalledWith(tx, 'institution-1', '2026-11-01', '2026-11-30');
    });

    it('is undefined when no year has a day in the span', async () => {
      expect(
        await build().directory.overlapping(tx, 'institution-1', '2020-01-01', '2020-01-31'),
      ).toBeUndefined();
    });
  });

  describe('yearToRead', () => {
    it('answers the year named, open or not, when it is one of the Institution’s', async () => {
      for (const status of [0, 1]) {
        await expect(
          build(year({ status })).directory.yearToRead(tx, 'institution-1', 'year-1'),
        ).resolves.toBe('year-1');
      }
    });

    it('is 404 for a year that is not there or is another Institution’s', async () => {
      for (const found of [undefined, year({ institution_id: 'institution-2' })]) {
        await expect(
          build(found).directory.yearToRead(tx, 'institution-1', 'year-1'),
        ).rejects.toMatchObject({ status: 404 });
      }
    });

    it('answers the current year when none is named, and is 422 CURRENT_YEAR_REQUIRED without one', async () => {
      await expect(build(year()).directory.yearToRead(tx, 'institution-1')).resolves.toBe('year-1');
      await expect(build().directory.yearToRead(tx, 'institution-1')).rejects.toMatchObject({
        status: 422,
        code: 'CURRENT_YEAR_REQUIRED',
      });
    });
  });
});
