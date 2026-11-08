import type { FileRow } from './files.repository.js';

/** What a client sees of a file (API design 15.1 step 3). Object keys and buckets never leave the server. */
export interface FileResource {
  id: string;
  purpose: number;
  contentType: string;
  sizeBytes: number;
  fileStatus: number;
}

export function fileResource(row: FileRow): FileResource {
  return {
    id: row.id,
    purpose: row.purpose,
    contentType: row.content_type,
    sizeBytes: row.size_bytes,
    fileStatus: row.file_status,
  };
}
