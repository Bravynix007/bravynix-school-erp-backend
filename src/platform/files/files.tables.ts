import type { ColumnType, Generated } from 'kysely';

/**
 * Kysely type of `files` (DDD 9.12): the metadata of every stored object. The content never enters the database,
 * and no URL is stored. A row is kept after its object is removed (`file_status` 4).
 */
export interface FilesTable {
  id: Generated<string>;
  created_at: ColumnType<Date, Date | undefined, never>;
  created_by: string | null;
  society_id: string;
  /** Empty for a file of the whole Society, such as its logo. */
  institution_id: string | null;
  /** 1 private, 2 public assets. */
  storage_bucket: number;
  object_key: string;
  /** DDD 16.2: 1 Society logo to 14 Consent evidence. */
  purpose: number;
  content_type: string;
  size_bytes: number;
  original_filename: string | null;
  checksum_sha256: Buffer | null;
  /** 1 pending, 2 ready, 3 rejected, 4 deleted. */
  file_status: Generated<number>;
  confirmed_at: Date | null;
  delete_after: Date | null;
  deleted_at: Date | null;
}
