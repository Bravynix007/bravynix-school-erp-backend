import type { Tx } from '../../platform/database/index.js';
import { AcademicYearDirectory } from './academic-year-directory.js';
import type { AcademicYearRepository, AcademicYearRow } from './academic-year.repository.js';

const tx = {} as Tx;
const year = (overrides: Partial<AcademicYearRow> = {}) =>
  ({ id: 'year-1', institution_id: 'institution-1', status: 1, ...overrides }) as AcademicYearRow;

const build = (found?: AcademicYearRow) => {
  const find = vi.fn<AcademicYearRepository['find']>().mockResolvedValue(found);
  const currentOf = vi.fn<AcademicYearRepository['currentOf']>().mockResolvedValue(found);
  return {
    directory: new AcademicYearDirectory({ find, currentOf } as unknown as AcademicYearRepository),
    find,
    currentOf,
  };
};

describe('AcademicYearDirectory', () => {
  describe('openIn', () => {
    it('says whether a year of the Institution is active', async () => {
      await expect(build(year()).directory.openIn(tx, 'year-1', 'institution-1')).resolves.toBe(
        true,
      );
      await expect(
        build(year({ status: 0 })).directory.openIn(tx, 'year-1', 'institution-1'),
      ).resolves.toBe(false);
    });

    it('is undefined for a year that is not there, and for one of another Institution', async () => {
      for (const found of [undefined, year({ institution_id: 'institution-2' })]) {
        await expect(
          build(found).directory.openIn(tx, 'year-1', 'institution-1'),
        ).resolves.toBeUndefined();
      }
    });
  });

  describe('spanOf', () => {
    it('gives the first and last day of a year, and undefined for one the caller cannot see', async () => {
      const found = year({ start_date: '2026-06-01', end_date: '2027-03-31' });
      await expect(build(found).directory.spanOf(tx, 'year-1')).resolves.toEqual({
        startDate: '2026-06-01',
        endDate: '2027-03-31',
      });
      await expect(build().directory.spanOf(tx, 'year-1')).resolves.toBeUndefined();
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
});
