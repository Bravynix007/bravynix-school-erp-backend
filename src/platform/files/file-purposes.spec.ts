import { RoleCode } from '../../common/auth/roles.js';
import {
  FilePurpose,
  IMAGE_TYPES,
  MAX_FILE_BYTES,
  PURPOSE_CODES,
  PURPOSES,
} from './file-purposes.js';

const ADMINS = [RoleCode.SocietyOwner, RoleCode.InstitutionAdmin];

describe('the purposes of a file (API design 15.2, DDD 16.2)', () => {
  it('registers exactly the purposes the People module uses', () => {
    expect(PURPOSE_CODES.toSorted((a, b) => a - b)).toEqual([3, 4, 5, 6, 12]);
  });

  it.each([
    ['student photo', FilePurpose.StudentPhoto, [...IMAGE_TYPES], false, false, null],
    ['staff photo', FilePurpose.StaffPhoto, [...IMAGE_TYPES], false, false, null],
    [
      'student document',
      FilePurpose.StudentDocument,
      [...IMAGE_TYPES, 'application/pdf'],
      true,
      true,
      null,
    ],
    [
      'staff document',
      FilePurpose.StaffDocument,
      [...IMAGE_TYPES, 'application/pdf'],
      true,
      true,
      null,
    ],
    ['import CSV', FilePurpose.ImportCsv, ['text/csv'], true, true, 7],
  ])(
    '%s: types, who uploads, whether its link is audited, whether its name is kept, how long it is kept',
    (_name, purpose, types, audited, keepsName, days) => {
      expect(PURPOSES[purpose]).toEqual({
        contentTypes: types,
        uploadRoles: ADMINS,
        auditedDownload: audited,
        keepsName,
        keepDays: days,
      });
    },
  );

  it('is limited to 5 MB', () => {
    expect(MAX_FILE_BYTES).toBe(5 * 1024 * 1024);
  });
});
