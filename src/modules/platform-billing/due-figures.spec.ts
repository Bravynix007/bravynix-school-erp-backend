import type { Tx } from '../../platform/database/index.js';
import { DueFigures } from './due-figures.js';
import type { DueRepository } from './due.repository.js';

const tx = {} as Tx;

describe('DueFigures', () => {
  it('hands the reads to the due repository', async () => {
    const outstandingBySociety = vi
      .fn<DueRepository['outstandingBySociety']>()
      .mockResolvedValue(new Map([['society-1', '8000.00']]));
    const outstandingTotal = vi.fn<DueRepository['outstandingTotal']>().mockResolvedValue('9.00');
    const collectedBetween = vi.fn<DueRepository['collectedBetween']>().mockResolvedValue('7.00');
    const figures = new DueFigures({
      outstandingBySociety,
      outstandingTotal,
      collectedBetween,
    } as unknown as DueRepository);

    expect(await figures.outstanding(tx, ['society-1'])).toEqual(
      new Map([['society-1', '8000.00']]),
    );
    expect(await figures.outstandingTotal(tx)).toBe('9.00');
    expect(await figures.collectedBetween(tx, '2026-11-01', '2026-12-01')).toBe('7.00');
    expect(outstandingBySociety).toHaveBeenCalledWith(tx, ['society-1']);
    expect(collectedBetween).toHaveBeenCalledWith(tx, '2026-11-01', '2026-12-01');
  });
});
