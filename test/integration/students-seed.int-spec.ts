import { Kysely, PostgresDialect, sql } from 'kysely';
import { DatabaseService } from '../../src/platform/database/index.js';
import { createPool } from '../../src/platform/database/database.service.js';
import { runMigrations } from '../../src/platform/database/migrator.js';
import { writeAcademicSeed } from '../../src/seeds/academic-seed.js';
import { writeBillingSeed } from '../../src/seeds/billing-seed.js';
import { writeIdentitySeed } from '../../src/seeds/identity-seed.js';
import { seededStudents, writeStudentSeed } from '../../src/seeds/people-seed.js';
import { children, institutions, personaByKey, societies } from '../../src/seeds/two-worlds.js';
import { createTestApp, type TestApp } from '../support/test-app.js';
import { FixtureModule } from '../support/fixture.module.js';

const migrationUrl = process.env.TEST_DATABASE_MIGRATION_URL!;

const tenant = (societyKey: string) => ({
  societyId: societies.find((society) => society.key === societyKey)!.id,
  institutionIds: institutions
    .filter((institution) => institution.society === societyKey)
    .map((institution) => institution.id),
});

/** The students of the two worlds (people-seed): placed in real sections, with their parents as guardians. */
describe('student seed', () => {
  let ownerDb: Kysely<unknown>;
  let t: TestApp;
  let database: DatabaseService;

  beforeAll(async () => {
    await runMigrations(migrationUrl, 'latest');
    ownerDb = new Kysely({
      dialect: new PostgresDialect({ pool: createPool(migrationUrl, 2, 30_000) }),
    });
    await writeIdentitySeed(ownerDb);
    await writeBillingSeed(ownerDb);
    await writeAcademicSeed(ownerDb);
    t = await createTestApp({ imports: [FixtureModule] });
    database = t.app.get(DatabaseService);
    await writeStudentSeed(ownerDb);
  });

  afterAll(async () => {
    await t.close();
    await ownerDb.destroy();
  });

  const rows = (societyKey: string) =>
    database.transaction(
      tenant(societyKey),
      async (tx) =>
        (
          await sql<{
            id: string;
            institution_id: string;
            section_id: string;
            roll_number: string;
            user_id: string | null;
            is_primary: boolean | null;
          }>`
          select s.id, s.institution_id, p.section_id, p.roll_number, g.user_id, g.is_primary
          from students s
          join student_enrolments e on e.student_id = s.id
          join student_section_placements p on p.student_enrolment_id = e.id
          left join student_guardians g on g.student_id = s.id
          order by s.id, g.user_id`.execute(tx)
        ).rows,
    );

  it('writes every child as a student of its Institution, in a section of it, once however often it runs', async () => {
    await writeStudentSeed(ownerDb);
    const all = [...(await rows('A')), ...(await rows('B'))];
    const students = [...new Set(all.map((row) => row.id))].toSorted();
    expect(students).toEqual(children.map((child) => child.id).toSorted());
    for (const seeded of seededStudents) {
      const row = all.find((candidate) => candidate.id === seeded.child.id)!;
      expect(row).toMatchObject({ institution_id: seeded.home.id, section_id: seeded.sectionId });
    }
  });

  it('gives each section distinct roll numbers', async () => {
    const all = [...(await rows('A')), ...(await rows('B'))];
    const placed = [...new Map(all.map((row) => [row.id, row])).values()];
    const keys = placed.map((row) => `${row.section_id}/${row.roll_number}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('links each parent persona to the children it names, the first as the primary guardian', async () => {
    const all = [...(await rows('A')), ...(await rows('B'))];
    const guardiansOf = (childKey: string) =>
      all.filter((row) => row.id === children.find((child) => child.key === childKey)!.id);
    expect(guardiansOf('C-A1-sib1')).toEqual([
      expect.objectContaining({ user_id: personaByKey('P-A1-siblings').id, is_primary: true }),
    ]);
    expect(guardiansOf('C-cross-A1').map((row) => row.user_id)).toEqual([
      personaByKey('P-cross').id,
    ]);
    expect(guardiansOf('C-dual').map((row) => row.user_id)).toEqual([
      personaByKey('TP-A1-dual').id,
    ]);
  });
});
