import type { ObjectStorage } from '../files/index.js';
import type { IdempotencyService } from '../idempotency/index.js';
import type { DueFile, SweepsRepository } from './sweeps.repository.js';
import {
  ATTENDANCE_YEARS_AHEAD,
  FILE_BATCH,
  INBOX_KEEP_DAYS,
  MAX_FILE_BATCHES,
  PARTITIONS_AHEAD,
} from './sweeps.rules.js';
import { SweepsService } from './sweeps.service.js';

const due = (id: string): DueFile => ({ id, objectKey: `k/${id}`, status: 1 });

function build(batches: DueFile[][] = []) {
  const repository = {
    expireFiles: vi.fn<SweepsRepository['expireFiles']>().mockResolvedValue(2),
    dueFiles: vi.fn<SweepsRepository['dueFiles']>(),
    markDeleted: vi.fn<SweepsRepository['markDeleted']>().mockResolvedValue(true),
    removeImportRuns: vi.fn<SweepsRepository['removeImportRuns']>().mockResolvedValue(3),
    ensureInboxPartitions: vi.fn<SweepsRepository['ensureInboxPartitions']>().mockResolvedValue(2),
    dropInboxPartitions: vi.fn<SweepsRepository['dropInboxPartitions']>().mockResolvedValue(1),
    ensureAttendancePartitions: vi
      .fn<SweepsRepository['ensureAttendancePartitions']>()
      .mockResolvedValue(1),
  };
  for (const batch of batches) repository.dueFiles.mockResolvedValueOnce(batch);
  repository.dueFiles.mockResolvedValue([]);
  const storage = { remove: vi.fn<ObjectStorage['remove']>().mockResolvedValue(undefined) };
  const idempotency = {
    sweepExpired: vi.fn<IdempotencyService['sweepExpired']>().mockResolvedValue(4),
  };
  return {
    service: new SweepsService(
      repository as unknown as SweepsRepository,
      storage as unknown as ObjectStorage,
      idempotency as unknown as IdempotencyService,
    ),
    repository,
    storage,
    idempotency,
  };
}

describe('SweepsService.sweep', () => {
  it('reports what each part did', async () => {
    const { service } = build([[due('f1'), due('f2')]]);
    expect(await service.sweep()).toEqual({
      filesExpired: 2,
      filesRemoved: 2,
      importRunsRemoved: 3,
      answersRemoved: 4,
      inboxPartitionsMade: 2,
      inboxPartitionsDropped: 1,
      attendancePartitionsMade: 1,
    });
  });

  it('removes the object before it marks the row', async () => {
    const { service, storage, repository } = build([[due('f1')]]);
    const order: string[] = [];
    storage.remove.mockImplementation(async () => void order.push('object'));
    repository.markDeleted.mockImplementation(async () => {
      order.push('row');
      return true;
    });
    await service.sweep();
    expect(order).toEqual(['object', 'row']);
  });

  it('leaves the row of a file whose object could not be removed, and goes on with the others', async () => {
    const { service, storage, repository } = build([[due('f1'), due('f2')]]);
    storage.remove.mockRejectedValueOnce(new Error('storage is down'));
    const report = await service.sweep();
    expect(repository.markDeleted).toHaveBeenCalledTimes(1);
    expect(repository.markDeleted).toHaveBeenCalledWith(due('f2'));
    expect(report.filesRemoved).toBe(1);
  });

  it('does not count a file that was confirmed in the meantime', async () => {
    const { service, repository } = build([[due('f1')]]);
    repository.markDeleted.mockResolvedValue(false);
    expect((await service.sweep()).filesRemoved).toBe(0);
  });

  it('asks past the files that failed, and stops when only they are left', async () => {
    const { service, storage, repository } = build([[due('f1')], [due('f1')]]);
    storage.remove.mockRejectedValue(new Error('storage is down'));
    await service.sweep();
    expect(repository.dueFiles).toHaveBeenCalledTimes(2);
    expect(repository.dueFiles).toHaveBeenLastCalledWith(FILE_BATCH + 1);
    expect(storage.remove).toHaveBeenCalledTimes(1);
  });

  it('removes a file listed behind files whose objects could not be removed', async () => {
    const { service, storage, repository } = build([
      [due('f1'), due('f2')],
      [due('f1'), due('f2'), due('f3')],
    ]);
    storage.remove.mockImplementation(async (key) => {
      if (key !== 'k/f3') throw new Error('this object cannot be removed');
    });
    const report = await service.sweep();
    expect(repository.dueFiles).toHaveBeenNthCalledWith(2, FILE_BATCH + 2);
    expect(repository.markDeleted).toHaveBeenCalledExactlyOnceWith(due('f3'));
    expect(report.filesRemoved).toBe(1);
  });

  it('passes over a file confirmed in the meantime instead of trying it again', async () => {
    const { service, repository, storage } = build([[due('f1')], [due('f1')]]);
    repository.markDeleted.mockResolvedValue(false);
    await service.sweep();
    expect(storage.remove).toHaveBeenCalledTimes(1);
  });

  it('works through further batches, up to a limit', async () => {
    const { service, repository } = build();
    repository.dueFiles.mockResolvedValue([due('f1')]);
    const report = await service.sweep();
    expect(repository.dueFiles).toHaveBeenCalledTimes(MAX_FILE_BATCHES);
    expect(repository.dueFiles).toHaveBeenCalledWith(FILE_BATCH);
    expect(report.filesRemoved).toBe(MAX_FILE_BATCHES);
  });

  it('does the other parts when one part fails', async () => {
    const { service, repository } = build();
    repository.expireFiles.mockRejectedValue(new Error('database is busy'));
    const report = await service.sweep();
    expect(report).toEqual({
      filesExpired: 0,
      filesRemoved: 0,
      importRunsRemoved: 3,
      answersRemoved: 4,
      inboxPartitionsMade: 2,
      inboxPartitionsDropped: 1,
      attendancePartitionsMade: 1,
    });
  });

  it('makes the partitions of the inboxes ahead, and drops those past their keeping', async () => {
    const { service, repository } = build();
    await service.sweep();
    expect(repository.ensureInboxPartitions).toHaveBeenCalledWith(PARTITIONS_AHEAD);
    expect(repository.dropInboxPartitions).toHaveBeenCalledWith(INBOX_KEEP_DAYS);
  });

  it('still drops the old partitions when the new ones could not be made', async () => {
    const { service, repository } = build();
    repository.ensureInboxPartitions.mockRejectedValue(new Error('database is busy'));
    const report = await service.sweep();
    expect(report).toMatchObject({ inboxPartitionsMade: 0, inboxPartitionsDropped: 1 });
  });

  it('makes the partitions of the attendance marks ahead, and goes on when it cannot', async () => {
    const { service, repository } = build();
    await service.sweep();
    expect(repository.ensureAttendancePartitions).toHaveBeenCalledWith(ATTENDANCE_YEARS_AHEAD);
    repository.ensureAttendancePartitions.mockRejectedValue(new Error('database is busy'));
    expect(await service.sweep()).toMatchObject({
      attendancePartitionsMade: 0,
      inboxPartitionsDropped: 1,
    });
  });
});
