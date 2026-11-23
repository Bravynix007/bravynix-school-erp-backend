import { Injectable, Logger } from '@nestjs/common';
import {
  ATTENDANCE_YEARS_AHEAD,
  FILE_BATCH,
  DOCUMENT_FILE_DAYS,
  IMPORT_RUN_DAYS,
  INBOX_KEEP_DAYS,
  MAX_FILE_BATCHES,
  PARTITIONS_AHEAD,
  UNREFERENCED_GRACE_HOURS,
} from './sweeps.rules.js';
import { IdempotencyService } from '../idempotency/index.js';
import { ObjectStorage } from '../files/index.js';
import { SweepsRepository } from './sweeps.repository.js';

/** What one sweep did. */
export interface SweepReport {
  /** Ready files given their `delete_after` because their document was deactivated or nothing points at them. */
  filesExpired: number;
  /** Files whose object was removed and whose row is now Deleted. */
  filesRemoved: number;
  /** Import runs removed. */
  importRunsRemoved: number;
  /** Stored answers of `idempotency_keys` past their 24 hours. */
  answersRemoved: number;
  /** Monthly partitions of the inboxes made ahead of time. */
  inboxPartitionsMade: number;
  /** Inbox partitions dropped for being past their keeping. */
  inboxPartitionsDropped: number;
  /** Yearly partitions of the attendance marks made ahead of time. */
  attendancePartitionsMade: number;
}

/**
 * The worker's clean-up (DDD 14.5, 16.3, 16.4; plan change 8). A sweep is idempotent and each part runs apart from the
 * others, so one that fails (the storage is out of reach) leaves the rest done and is tried again at the next sweep.
 */
@Injectable()
export class SweepsService {
  private readonly logger = new Logger(SweepsService.name);

  constructor(
    private readonly sweeps: SweepsRepository,
    private readonly storage: ObjectStorage,
    private readonly idempotency: IdempotencyService,
  ) {}

  async sweep(): Promise<SweepReport> {
    const report: SweepReport = {
      filesExpired: 0,
      filesRemoved: 0,
      importRunsRemoved: 0,
      answersRemoved: 0,
      inboxPartitionsMade: 0,
      inboxPartitionsDropped: 0,
      attendancePartitionsMade: 0,
    };
    report.filesExpired = await this.part('expire files', () =>
      this.sweeps.expireFiles(DOCUMENT_FILE_DAYS, UNREFERENCED_GRACE_HOURS),
    );
    report.filesRemoved = await this.part('remove files', () => this.removeDueFiles());
    report.importRunsRemoved = await this.part('remove import runs', () =>
      this.sweeps.removeImportRuns(IMPORT_RUN_DAYS),
    );
    report.answersRemoved = await this.part('expire stored answers', () =>
      this.idempotency.sweepExpired(),
    );
    // Ahead first: a row that arrives in a month with no partition has nowhere to go (DDD 14.5). The audit log's
    // partitions are not made here: that function is the platform role's, and the app role is refused it (migration 0002).
    report.inboxPartitionsMade = await this.part('make inbox partitions', () =>
      this.sweeps.ensureInboxPartitions(PARTITIONS_AHEAD),
    );
    report.inboxPartitionsDropped = await this.part('drop old inbox partitions', () =>
      this.sweeps.dropInboxPartitions(INBOX_KEEP_DAYS),
    );
    report.attendancePartitionsMade = await this.part('make attendance partitions', () =>
      this.sweeps.ensureAttendancePartitions(ATTENDANCE_YEARS_AHEAD),
    );
    this.logger.log(report, 'Sweep done');
    return report;
  }

  /**
   * Removes the object of each due file and then marks its row Deleted: a row is never marked while its object may
   * still be there. A file whose object could not be removed is left for the next sweep, and the next look asks past
   * it, so files that keep failing at the head of the list never hold back the ones behind them.
   */
  private async removeDueFiles(): Promise<number> {
    let removed = 0;
    // The files this sweep has tried and could not settle: still listed, and passed over.
    const passed = new Set<string>();
    for (let batch = 0; batch < MAX_FILE_BATCHES; batch++) {
      const due = (await this.sweeps.dueFiles(FILE_BATCH + passed.size)).filter(
        (file) => !passed.has(file.id),
      );
      // Only files this sweep could not settle are left: another look would find the same ones.
      if (due.length === 0) break;
      for (const file of due) {
        try {
          await this.storage.remove(file.objectKey);
        } catch (error) {
          this.logger.warn({ err: error, fileId: file.id }, 'A file object could not be removed');
          passed.add(file.id);
          continue;
        }
        if (await this.sweeps.markDeleted(file)) removed++;
        else passed.add(file.id);
      }
    }
    return removed;
  }

  private async part(name: string, work: () => Promise<number>): Promise<number> {
    try {
      return await work();
    } catch (error) {
      this.logger.error({ err: error }, `The sweep could not ${name}`);
      return 0;
    }
  }
}
