import { MASTER_SPECS } from './master.catalog.js';
import { isNotModified, listEtag, masterEntry, type MasterRow } from './master.resource.js';

const row: MasterRow = {
  id: '0192f3b0-0000-7000-8000-000000000001',
  status: 1,
  version: 3,
  created_by: '0192f3b0-0000-7000-8000-0000000000aa',
  code: 'HIGH_SCHOOL',
  name: 'High School',
  display_order: 5,
};

describe('masterEntry', () => {
  it('shows the fields of the master under their API names, and no author stamps', () => {
    expect(masterEntry(MASTER_SPECS['class-categories'], row)).toEqual({
      id: row.id,
      status: 1,
      version: 3,
      code: 'HIGH_SCHOOL',
      name: 'High School',
      displayOrder: 5,
    });
  });

  it('keeps an empty optional field as null', () => {
    const entry = masterEntry(MASTER_SPECS.countries, {
      ...row,
      name: 'India',
      iso2: 'IN',
      phone_code: null,
      currency: null,
    });
    expect(entry).toMatchObject({ phoneCode: null, currency: null });
  });
});

describe('listEtag', () => {
  const entries = [masterEntry(MASTER_SPECS['class-categories'], row)];

  it('is a weak tag that is the same for the same entries', () => {
    expect(listEtag(entries)).toMatch(/^W\/"[A-Za-z0-9_-]{22}"$/);
    expect(listEtag(structuredClone(entries))).toBe(listEtag(entries));
  });

  it('changes when an entry changes, including its version or whether it is shown', () => {
    const [entry] = entries;
    expect(listEtag([{ ...entry!, name: 'Other' }])).not.toBe(listEtag(entries));
    expect(listEtag([{ ...entry!, version: 4 }])).not.toBe(listEtag(entries));
    expect(listEtag([])).not.toBe(listEtag(entries));
  });
});

describe('isNotModified', () => {
  const etag = 'W/"abc"';

  it('matches the tag, weak or strong, among several', () => {
    expect(isNotModified('W/"abc"', etag)).toBe(true);
    expect(isNotModified('"abc"', etag)).toBe(true);
    expect(isNotModified('"zzz", W/"abc"', etag)).toBe(true);
    expect(isNotModified('*', etag)).toBe(true);
  });

  it('does not match another tag or no header', () => {
    expect(isNotModified('W/"abd"', etag)).toBe(false);
    expect(isNotModified('', etag)).toBe(false);
    expect(isNotModified(undefined, etag)).toBe(false);
  });
});
