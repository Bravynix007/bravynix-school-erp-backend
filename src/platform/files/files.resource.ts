import type { FileRow } from './files.repository.js';

/** What a client sees of a file (API design 15.1 step 3). Object keys and buckets never leave the server. */
export interface FileResource {
  id: string;
  purpose: number;
  contentType: string;
  sizeBytes: number;
  fileStatus: number;
  /** Only for a public file (an event image): the address anyone can read it at. */
  url?: string;
}

export function fileResource(row: FileRow, url?: string): FileResource {
  return {
    id: row.id,
    purpose: row.purpose,
    contentType: row.content_type,
    sizeBytes: row.size_bytes,
    fileStatus: row.file_status,
    ...(url === undefined ? {} : { url }),
  };
}
