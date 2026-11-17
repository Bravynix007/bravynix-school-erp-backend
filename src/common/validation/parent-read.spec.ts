import { parentReadErrors, staffReadErrors } from './parent-read.js';

interface Query {
  studentId?: string;
  institutionId?: string;
  academicYearId?: string;
  sectionId?: string;
}

const query = (fields: Query): Query => fields;

describe('parentReadErrors', () => {
  it('needs the child and takes none of the fields that would widen the read', () => {
    expect(parentReadErrors(query({}), ['institutionId'])).toEqual([
      expect.objectContaining({ field: 'studentId', code: 'REQUIRED' }),
    ]);
    expect(
      parentReadErrors(query({ studentId: 's', institutionId: 'i', sectionId: 'x' }), [
        'institutionId',
        'academicYearId',
        'sectionId',
      ]),
    ).toEqual([
      expect.objectContaining({ field: 'institutionId', code: 'FIELD_NOT_ALLOWED' }),
      expect.objectContaining({ field: 'sectionId', code: 'FIELD_NOT_ALLOWED' }),
    ]);
  });

  it('is content with the child alone', () => {
    expect(parentReadErrors(query({ studentId: 's' }), ['institutionId'])).toEqual([]);
  });
});

describe('staffReadErrors', () => {
  it('gives no one but a parent a child to name', () => {
    expect(staffReadErrors({})).toEqual([]);
    expect(staffReadErrors({ studentId: 's' })).toEqual([
      expect.objectContaining({ field: 'studentId', code: 'FIELD_NOT_ALLOWED' }),
    ]);
  });
});
