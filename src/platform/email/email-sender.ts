export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
  /** Template name, e.g. `otp`, for logs and test assertions. Never the content. */
  template: string;
  /** Values the template used, kept only by the in-memory sink for tests. */
  variables?: Record<string, string>;
}

/**
 * The one way the backend sends email. Swap the driver with `EMAIL_DRIVER`:
 * `memory` for tests (read OTP codes back), `log` for local runs without a
 * mail server, `smtp` for Mailpit locally and Amazon SES in staging and
 * production.
 */
export abstract class EmailSender {
  abstract send(message: EmailMessage): Promise<void>;
}
