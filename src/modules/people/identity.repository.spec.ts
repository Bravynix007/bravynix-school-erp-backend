import { sqlRecorder } from '../../../test/support/sql-recorder.js';
import { IdentityRepository } from './identity.repository.js';

const repository = new IdentityRepository();
const sealed = {
  ciphertext: Buffer.from('sealed'),
  keyVersion: 1,
  hmac: Buffer.alloc(32, 7),
  last4: '0124',
};

describe('IdentityRepository', () => {
  it('finds the row of a staff member', async () => {
    const { tx, queries } = sqlRecorder();
    await repository.find(tx, 'staff-1');
    expect(queries[0]!.sql).toContain('from "staff_identities" where "staff_member_id" = $1');
    expect(queries[0]!.parameters).toEqual(['staff-1']);
  });

  it('finds the other record that holds a hash, with the status of that record', async () => {
    const { tx, queries } = sqlRecorder();
    await repository.holderOf(tx, sealed.hmac, 'staff-1');
    const { sql, parameters } = queries[0]!;
    expect(sql).toContain('inner join "staff_members" as "s" on "s"."id" = "i"."staff_member_id"');
    expect(sql).toContain('"i"."aadhaar_hmac" = $1');
    expect(sql).toContain('"i"."staff_member_id" <> $2');
    expect(parameters).toEqual([sealed.hmac, 'staff-1']);
  });

  it('writes the four columns as one, or all empty, and updates the row when it exists', async () => {
    const slot = { staffMemberId: 'staff-1', societyId: 'society-1', by: 'admin-1' };
    const set = sqlRecorder();
    await repository.put(set.tx, slot, sealed);
    expect(set.queries[0]!.sql).toMatch(/^insert into "staff_identities"/);
    expect(set.queries[0]!.sql).toContain('on conflict ("staff_member_id") do update set');
    expect(set.queries[0]!.parameters).toContain(sealed.ciphertext);
    expect(set.queries[0]!.parameters).toContain('0124');

    const clear = sqlRecorder();
    await repository.put(clear.tx, slot, null);
    expect(clear.queries[0]!.parameters.filter((value) => value === null)).toHaveLength(8);
  });
});
