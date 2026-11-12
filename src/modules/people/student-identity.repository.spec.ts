import { sqlRecorder } from '../../../test/support/sql-recorder.js';
import { StudentIdentityRepository } from './student-identity.repository.js';

const repository = new StudentIdentityRepository();
const sealed = {
  ciphertext: Buffer.from('sealed'),
  keyVersion: 1,
  hmac: Buffer.alloc(32, 7),
  last4: '0124',
};
const slot = {
  studentId: 'student-1',
  societyId: 'society-1',
  institutionId: 'institution-1',
  by: 'admin-1',
};

describe('StudentIdentityRepository', () => {
  it('finds the row of a student', async () => {
    const { tx, queries } = sqlRecorder();
    await repository.find(tx, 'student-1');
    expect(queries[0]!.sql).toContain('from "student_identities" where "student_id" = $1');
    expect(queries[0]!.parameters).toEqual(['student-1']);
  });

  it('finds the other student of the Institution who holds a hash, with their status', async () => {
    const { tx, queries } = sqlRecorder();
    await repository.holderOf(tx, 'institution-1', sealed.hmac, 'student-1');
    const { sql, parameters } = queries[0]!;
    expect(sql).toContain('inner join "students" as "s" on "s"."id" = "i"."student_id"');
    expect(sql).toContain('"i"."institution_id" = $1');
    expect(sql).toContain('"i"."aadhaar_hmac" = $2');
    expect(sql).toContain('"i"."student_id" <> $3');
    expect(parameters).toEqual(['institution-1', sealed.hmac, 'student-1']);
  });

  it('asks the definer function whether another Institution holds a hash', async () => {
    const { tx, queries } = sqlRecorder();
    expect(await repository.heldElsewhere(tx, 'institution-1', sealed.hmac)).toBe(false);
    expect(queries[0]!.sql).toContain('app_student_aadhaar_elsewhere(');
    expect(queries[0]!.parameters).toEqual(['institution-1', sealed.hmac]);
  });

  it('writes the four Aadhaar columns as one, and the certificate, and updates the row when it exists', async () => {
    const set = sqlRecorder();
    await repository.put(set.tx, slot, { aadhaar: sealed, birthCertificateNumber: 'BC-1' });
    const { sql, parameters } = set.queries[0]!;
    expect(sql).toMatch(/^insert into "student_identities"/);
    expect(sql).toContain('on conflict ("student_id") do update set');
    expect(parameters).toContain(sealed.ciphertext);
    expect(parameters).toContain('0124');
    expect(parameters).toContain('BC-1');
  });

  it('leaves out what it is not given: a certificate alone does not touch the Aadhaar columns', async () => {
    const { tx, queries } = sqlRecorder();
    await repository.put(tx, slot, { birthCertificateNumber: 'BC-1' });
    expect(queries[0]!.sql).not.toContain('aadhaar_ciphertext');
    expect(queries[0]!.sql).toContain('"birth_certificate_number"');
  });

  it('clears the four Aadhaar columns together with null', async () => {
    const { tx, queries } = sqlRecorder();
    await repository.put(tx, slot, { aadhaar: null });
    expect(queries[0]!.sql).not.toContain('birth_certificate_number');
    expect(queries[0]!.parameters.filter((value) => value === null)).toHaveLength(8);
  });
});
