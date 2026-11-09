import type { Tx } from '../database/index.js';
import { InstitutionDirectory } from './institution-directory.js';
import type { InstitutionRepository } from './institution.repository.js';
import type { SocietyRepository } from './society.repository.js';

type Ref =
  Awaited<ReturnType<InstitutionRepository['refs']>> extends Map<string, infer R> ? R : never;

const institution = (id: string, status = 1, society = 'society-1'): [string, Ref] => [
  id,
  { id, name: id, society_id: society, status },
];

function build(institutions: [string, Ref][], societyStatus = 1) {
  const refs = vi.fn<InstitutionRepository['refs']>().mockResolvedValue(new Map(institutions));
  const societyRefs = vi
    .fn<SocietyRepository['refs']>()
    .mockResolvedValue(
      new Map([
        ['society-1', { id: 'society-1', code: 'SUN', name: 'Sunrise', status: societyStatus }],
      ]),
    );
  const directory = new InstitutionDirectory(
    { refs } as unknown as InstitutionRepository,
    { refs: societyRefs } as unknown as SocietyRepository,
  );
  return { directory, refs, societyRefs };
}

const tx = {} as Tx;
const items = [
  { id: 'a', field: 'institutionIds[0]' },
  { id: 'b', field: 'institutionIds[1]' },
];

describe('InstitutionDirectory.requireActive', () => {
  it('reads every Institution and every Society once, and lets active ones through', async () => {
    const t = build([institution('a'), institution('b')]);
    await expect(t.directory.requireActive(tx, items)).resolves.toBeUndefined();
    expect(t.refs).toHaveBeenCalledWith(tx, ['a', 'b']);
    expect(t.societyRefs).toHaveBeenCalledTimes(1);
    expect(t.societyRefs).toHaveBeenCalledWith(tx, ['society-1']);
  });

  it('is 404 for an Institution the caller cannot see', async () => {
    const t = build([institution('a')]);
    await expect(t.directory.requireActive(tx, items)).rejects.toMatchObject({ status: 404 });
  });

  it('is 422 on the field of the first Institution that is deactivated', async () => {
    const t = build([institution('a', 0), institution('b', 0)]);
    await expect(t.directory.requireActive(tx, items)).rejects.toMatchObject({
      status: 422,
      code: 'REFERENCE_INACTIVE',
      options: { errors: [{ field: 'institutionIds[0]', code: 'REFERENCE_INACTIVE' }] },
    });
  });

  it('is 422 when the Society of an active Institution is deactivated', async () => {
    const t = build([institution('a'), institution('b')], 0);
    await expect(t.directory.requireActive(tx, items)).rejects.toMatchObject({
      status: 422,
      code: 'REFERENCE_INACTIVE',
    });
  });
});
