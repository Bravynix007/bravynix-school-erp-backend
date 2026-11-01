import { rateInForce } from './price-rate.rules.js';

const rates = [
  { id: 'r2', effective_from_date: '2026-10-01' },
  { id: 'r1', effective_from_date: '2026-04-01' },
  { id: 'r3', effective_from_date: '2027-04-01' },
];

describe('rateInForce', () => {
  it('is the latest rate that started on or before the day, whatever order they come in', () => {
    expect(rateInForce(rates, '2026-10-28')?.id).toBe('r2');
    expect(rateInForce(rates, '2027-03-31')?.id).toBe('r2');
    expect(rateInForce(rates, '2027-04-02')?.id).toBe('r3');
  });

  it('counts the first day of a rate as inside it', () => {
    expect(rateInForce(rates, '2026-04-01')?.id).toBe('r1');
    expect(rateInForce(rates, '2026-10-01')?.id).toBe('r2');
    expect(rateInForce(rates, '2026-09-30')?.id).toBe('r1');
  });

  it('is nothing before the first rate starts, and for no rates at all', () => {
    expect(rateInForce(rates, '2026-03-31')).toBeUndefined();
    expect(rateInForce([], '2026-10-28')).toBeUndefined();
  });
});
