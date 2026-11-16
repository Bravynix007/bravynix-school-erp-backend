import type { ObjectStorage } from '../files/index.js';
import type { IdempotencyService } from '../idempotency/index.js';
import type { DueFile, SweepsRepository } from './sweeps.repository.js';
import { FILE_BATCH, MAX_FILE_BATCHES } from './sweeps.rules.js';
import { SweepsService } from './sweeps.service.js';

const due = (id: string): DueFile => ({ id, objectKey: `k/${id}`, status: 1 });

function build(batches: DueFile[][] = []) {
  const repository = {
    expireFiles: vi.fn<SweepsRepository['expireFiles']>().mockResolvedValue(2),
    dueFiles: vi.fn<SweepsRepository['dueFiles']>(),
    markDeleted: vi.fn<SweepsRepository['markDeleted']>().mockResolvedValue(true),
    removeImportRuns: vi.fn<SweepsRepository['removeImportRuns']>().mockResolvedValue(3),
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

  it('stops looking when a whole batch failed, so it does not ask for the same files again', async () => {
    const { service, storage, repository } = build([[due('f1')], [due('f1')]]);
    storage.remove.mockRejectedValue(new Error('storage is down'));
    await service.sweep();
    expect(repository.dueFiles).toHaveBeenCalledTimes(1);
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
    });
  });
});
