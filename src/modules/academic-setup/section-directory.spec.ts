import { AppException } from '../../common/http/app-exception.js';
import type { Principal } from '../../common/auth/access-token-verifier.js';
import type { DatabaseService, Tx } from '../../platform/database/index.js';
import type { InstitutionContext, ScopeService } from '../../platform/tenancy/index.js';
import { SectionDirectory } from './section-directory.js';
import type { SectionRepository, SectionRow } from './section.repository.js';

const tx = {} as Tx;
const section = (overrides: Partial<SectionRow> = {}) =>
  ({ id: 'section-1', institution_id: 'institution-1', status: 1, ...overrides }) as SectionRow;

const principal = { personId: 'person-1' } as Principal;
const context = { institutionId: 'institution-1' } as InstitutionContext;

const build = (found?: SectionRow) => {
  const find = vi.fn<SectionRepository['find']>().mockResolvedValue(found);
  const keptOpen = vi.fn<SectionRepository['keptOpen']>().mockResolvedValue(found);
  const namesOf = vi
    .fn<SectionRepository['namesOf']>()
    .mockResolvedValue(
      new Map([['section-1', { displayName: 'A', classId: 'c', className: '5' }]]),
    );
  const transaction = vi.fn<DatabaseService['transaction']>((_tenant, work) => work(tx));
  const forPrincipal = vi
    .fn<ScopeService['forPrincipal']>()
    .mockResolvedValue({ tenant: { societyId: 'society-1' } } as Awaited<
      ReturnType<ScopeService['forPrincipal']>
    >);
  const requireInstitution = vi.fn<ScopeService['requireInstitution']>().mockResolvedValue(context);
  return {
    directory: new SectionDirectory(
      { find, keptOpen, namesOf } as unknown as SectionRepository,
      { transaction } as unknown as DatabaseService,
      { forPrincipal, requireInstitution } as unknown as ScopeService,
    ),
    requireInstitution,
    find,
    keptOpen,
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

  describe('contextOf', () => {
    it('gives the Institution of a section the caller reaches', async () => {
      const t = build(section());
      await expect(t.directory.contextOf(principal, 'section-1')).resolves.toBe(context);
      expect(t.requireInstitution).toHaveBeenCalledWith(principal, 'institution-1');
    });

    it('is 404 for a section the caller cannot see, and for an Institution out of their reach', async () => {
      await expect(build().directory.contextOf(principal, 'section-1')).rejects.toMatchObject({
        status: 404,
      });
      const t = build(section());
      t.requireInstitution.mockRejectedValue(AppException.notFound());
      await expect(t.directory.contextOf(principal, 'section-1')).rejects.toMatchObject({
        status: 404,
      });
    });
  });

  describe('placeOf', () => {
    it('gives the class, the Institution, whether it is open and its capacity', async () => {
      const t = build(section({ class_id: 'class-1', capacity: 40 }));
      await expect(t.directory.placeOf(tx, 'section-1')).resolves.toEqual({
        classId: 'class-1',
        institutionId: 'institution-1',
        active: true,
        capacity: 40,
      });
    });

    it('holds the section open until the transaction ends, so it cannot be deactivated meanwhile', async () => {
      const t = build(section({ class_id: 'class-1' }));
      await t.directory.placeOf(tx, 'section-1');
      expect(t.keptOpen).toHaveBeenCalledWith(tx, 'section-1');
      expect(t.find).not.toHaveBeenCalled();
    });

    it('says a deactivated section is not active', async () => {
      const t = build(section({ status: 0, class_id: 'class-1', capacity: null }));
      await expect(t.directory.placeOf(tx, 'section-1')).resolves.toMatchObject({
        active: false,
        capacity: null,
      });
    });

    it('is undefined for a section the caller cannot see', async () => {
      await expect(build().directory.placeOf(tx, 'section-1')).resolves.toBeUndefined();
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
