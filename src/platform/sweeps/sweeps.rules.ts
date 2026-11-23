/** Days a document's file is kept after DOC-03 deactivated the document (DDD 16.2, 16.3). */
export const DOCUMENT_FILE_DAYS = 30;

/**
 * Hours a Ready file may wait for the record that will point at it (a photo uploaded in a form that is not yet saved)
 * before the check for files nothing points at gives it up (DDD 16.4).
 */
export const UNREFERENCED_GRACE_HOURS = 24;

/** Days an import run is kept after it finished (API design 16.3); its file goes with it (DDD 16.2). */
export const IMPORT_RUN_DAYS = 7;

/** Days a notice is kept in an inbox before its month's partition is dropped whole (DDD 9.8). */
export const INBOX_KEEP_DAYS = 180;

/** Months after this one whose partitions of the inboxes are made ahead (DDD 14.5). */
export const PARTITIONS_AHEAD = 3;

/** Calendar years after this one whose partitions of the attendance marks are made ahead (DDD 14.5). */
export const ATTENDANCE_YEARS_AHEAD = 1;

/** How many files are removed in one look at the list of those that are due. */
export const FILE_BATCH = 100;

/** The most batches of files one sweep removes; the rest wait for the next sweep, so one sweep never runs on. */
export const MAX_FILE_BATCHES = 50;

/** How long the worker waits between sweeps: hourly, as the answers of `idempotency_keys` are swept (DDD 14.2). */
export const SWEEP_INTERVAL_MS = 3_600_000;
