import type { EmailMessage } from '../../platform/email/index.js';
import type { DueResource } from './due.resource.js';
import { rupees } from './due.rules.js';

/** `2026-04-01` as `1 Apr 2026`. The value is a calendar date, so no time zone applies. */
function readableDate(isoDate: string): string {
  return new Date(`${isoDate}T00:00:00Z`).toLocaleDateString('en-IN', {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

/** Tells a Society Owner that BravyNix raised a due against one of their Institutions (PRD 9.3, 10). */
export function dueRaisedEmail(to: string, due: DueResource): EmailMessage {
  const lines = [
    `BravyNix has raised an invoice for ${due.institution.name} (${due.societyName}).`,
    '',
    `Invoice: ${due.invoiceNo}`,
    `Period: ${readableDate(due.periodStartDate)} to ${readableDate(due.periodEndDate)}`,
    `Amount: ${rupees(due.totalAmount)}`,
  ];
  if (due.dueDate !== null) lines.push(`Pay by: ${readableDate(due.dueDate)}`);
  lines.push('', 'You can see it under Platform dues in the app.');
  return {
    to,
    template: 'platform-due-raised',
    subject: `Invoice ${due.invoiceNo} from BravyNix`,
    text: lines.join('\n'),
    variables: { invoiceNo: due.invoiceNo, totalAmount: due.totalAmount },
  };
}
