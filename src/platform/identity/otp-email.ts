import type { EmailMessage } from '../email/email-sender.js';
import { OTP_LIMITS } from './otp-limits.js';

/**
 * The login code email. English for now: the other six languages arrive with
 * the translation pass (PRD 11.3), and fall back to English until then. The
 * code is in the text only; it is never logged (README rules).
 */
export function otpEmail(to: string, code: string): EmailMessage {
  const minutes = String(OTP_LIMITS.codeLifeSeconds / 60);
  return {
    to,
    template: 'otp',
    subject: 'Your BravyNix School ERP login code',
    text: [
      `Your login code is ${code}.`,
      '',
      `It works once and expires in ${minutes} minutes.`,
      'If you did not ask for it, you can ignore this email. Nobody can sign in without the code.',
      'We will never ask you to share this code.',
    ].join('\n'),
    variables: { code, minutes },
  };
}
