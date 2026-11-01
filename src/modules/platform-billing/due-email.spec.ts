import { dueRaisedEmail } from './due-email.js';
import type { DueResource } from './due.resource.js';

const due = {
  invoiceNo: 'BNX/FY2026-27/0007',
  societyName: 'Sri Vidya Educational Society',
  institution: { id: 'inst-1', name: 'Sri Vidya High School' },
  periodStartDate: '2026-04-01',
  periodEndDate: '2027-03-31',
  totalAmount: '1950000.00',
  dueDate: '2026-05-15',
} as DueResource;

describe('dueRaisedEmail', () => {
  it('names the invoice, the Institution, the period, the amount and the date to pay by', () => {
    const mail = dueRaisedEmail('asha@demo.test', due);
    expect(mail).toMatchObject({
      to: 'asha@demo.test',
      template: 'platform-due-raised',
      subject: 'Invoice BNX/FY2026-27/0007 from BravyNix',
    });
    expect(mail.text).toContain('Sri Vidya High School (Sri Vidya Educational Society)');
    expect(mail.text).toContain('Period: 1 Apr 2026 to 31 Mar 2027');
    expect(mail.text).toContain('Amount: ₹19,50,000.00');
    expect(mail.text).toContain('Pay by: 15 May 2026');
  });

  it('leaves out the date to pay by when the due has none', () => {
    expect(dueRaisedEmail('a@demo.test', { ...due, dueDate: null }).text).not.toContain('Pay by');
  });
});
