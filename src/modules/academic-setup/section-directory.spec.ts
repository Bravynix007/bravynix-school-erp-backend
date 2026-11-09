import type { Tx } from '../../platform/database/index.js';
import { SectionDirectory } from './section-directory.js';
import type { SectionRepository, SectionRow } from './section.repository.js';

const tx = {} as Tx;
const section = (overrides: Partial<SectionRow> = {}) =>
  ({ id: 'section-1', institution_id: 'institution-1', status: 1, ...overrides }) as SectionRow;

const build = (found?: SectionRow) => {
  const find = vi.fn<SectionRepository['find']>().mockResolvedValue(found);
  const namesOf = vi
    .fn<SectionRepository['namesOf']>()
    .mockResolvedValue(
      new Map([['section-1', { displayName: 'A', classId: 'c', className: '5' }]]),
    );
  return {
    directory: new SectionDirectory({ find, namesOf } as unknown as SectionRepository),
    find,
    namesOf,
  };
};

describe('SectionDirectory', () => {
  describe('requireActive', () => {
    it('accepts an active section', async () => {
      const t = build(section());
      await expect(
        t.directory.requireActive(tx, 'section-1', 'sectionId'),
      ).resolves.toBeUndefined();
      expect(t.find).toHaveBeenCalledWith(tx, 'section-1');
    });

    it('is 404 for a section the caller cannot see', async () => {
      await expect(
        build().directory.requireActive(tx, 'section-1', 'sectionId'),
      ).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
    });

    it('is 422 REFERENCE_INACTIVE on the field for a deactivated section', async () => {
      await expect(
        build(section({ status: 0 })).directory.requireActive(tx, 'section-1', 'sectionId'),
      ).rejects.toMatchObject({
        status: 422,
        options: { errors: [{ field: 'sectionId', code: 'REFERENCE_INACTIVE' }] },
      });
    });
  });

  it('names sections and their classes through the repository', async () => {
    const t = build();
    expect((await t.directory.names(tx, ['section-1'])).get('section-1')).toEqual({
      displayName: 'A',
      classId: 'c',
      className: '5',
    });
    expect(t.namesOf).toHaveBeenCalledWith(tx, ['section-1']);
  });
});
