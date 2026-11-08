import { hasValidCheckDigit, maskAadhaar, normaliseAadhaar } from './aadhaar.js';

describe('Aadhaar numbers', () => {
  it('checks the Verhoeff digit', () => {
    expect(hasValidCheckDigit('2363')).toBe(true);
    expect(hasValidCheckDigit('234567890124')).toBe(true);
    expect(hasValidCheckDigit('987654321096')).toBe(true);
    expect(hasValidCheckDigit('234567890125')).toBe(false);
  });

  it('catches every single-digit slip and every swap of neighbours in a number', () => {
    const number = '234567890124';
    for (let i = 0; i < number.length; i++) {
      for (const digit of '0123456789') {
        if (digit === number[i]) continue;
        const slip = number.slice(0, i) + digit + number.slice(i + 1);
        expect(hasValidCheckDigit(slip)).toBe(false);
      }
    }
    for (let i = 0; i + 1 < number.length; i++) {
      if (number[i] === number[i + 1]) continue;
      const swapped = number.slice(0, i) + number[i + 1] + number[i] + number.slice(i + 2);
      expect(hasValidCheckDigit(swapped)).toBe(false);
    }
  });

  it('takes spaces and hyphens away and returns the twelve digits', () => {
    expect(normaliseAadhaar('2345 6789 0124')).toBe('234567890124');
    expect(normaliseAadhaar('2345-6789-0124')).toBe('234567890124');
    expect(normaliseAadhaar(' 234567890124 ')).toBe('234567890124');
  });

  it('refuses anything else', () => {
    for (const bad of [
      '',
      '23456789012',
      '2345678901245',
      '2345 6789 012x',
      '234567890125',
      '２３４５６７８９０１２４',
      '2345.6789.0124',
    ]) {
      expect(normaliseAadhaar(bad)).toBeNull();
    }
  });

  it('shows only the last four digits', () => {
    expect(maskAadhaar('0124')).toBe('XXXX XXXX 0124');
  });
});
