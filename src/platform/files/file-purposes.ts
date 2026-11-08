import { RoleCode } from '../../common/auth/roles.js';

/** The largest file anyone may upload (PRD 11.2, API design 15.4). */
export const MAX_FILE_BYTES = 5_242_880;

export const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
const DOCUMENT_TYPES = [...IMAGE_TYPES, 'application/pdf'] as const;

/** The purposes the People module uses (DDD 16.2). The others join when the module that owns them is built. */
export const FilePurpose = {
  StudentPhoto: 3,
  StaffPhoto: 4,
  StudentDocument: 5,
  StaffDocument: 6,
  ImportCsv: 12,
} as const;
export type FilePurpose = (typeof FilePurpose)[keyof typeof FilePurpose];

export interface PurposeRule {
  /** Content types the purpose accepts; the first bytes of the file must match the declared one. */
  contentTypes: readonly string[];
  /** Roles that may ask to upload (API design 15.2). */
  uploadRoles: readonly RoleCode[];
  /** A link to the file is written to the audit log (API design 15.2). */
  auditedDownload: boolean;
  /** The name the uploader gave is kept: documents and imports show it, photos do not (DDD 9.12). */
  keepsName: boolean;
  /** Days an import is kept before the sweep removes it; none for the rest. */
  keepDays: number | null;
}

const ADMINS = [RoleCode.SocietyOwner, RoleCode.InstitutionAdmin];

/** Who may upload what, which types are allowed and which links are audited (API design 15.2). */
export const PURPOSES: Readonly<Record<FilePurpose, PurposeRule>> = {
  [FilePurpose.StudentPhoto]: {
    contentTypes: IMAGE_TYPES,
    uploadRoles: ADMINS,
    auditedDownload: false,
    keepsName: false,
    keepDays: null,
  },
  [FilePurpose.StaffPhoto]: {
    contentTypes: IMAGE_TYPES,
    uploadRoles: ADMINS,
    auditedDownload: false,
    keepsName: false,
    keepDays: null,
  },
  [FilePurpose.StudentDocument]: {
    contentTypes: DOCUMENT_TYPES,
    uploadRoles: ADMINS,
    auditedDownload: true,
    keepsName: true,
    keepDays: null,
  },
  [FilePurpose.StaffDocument]: {
    contentTypes: DOCUMENT_TYPES,
    uploadRoles: ADMINS,
    auditedDownload: true,
    keepsName: true,
    keepDays: null,
  },
  [FilePurpose.ImportCsv]: {
    contentTypes: ['text/csv'],
    uploadRoles: ADMINS,
    auditedDownload: true,
    keepsName: true,
    keepDays: 7,
  },
};

export const PURPOSE_CODES = Object.keys(PURPOSES).map(Number) as FilePurpose[];

/** Every purpose the People module uses is private (DDD 16.2); the public ones are logos, events and banners. */
export const PRIVATE_BUCKET = 1;
