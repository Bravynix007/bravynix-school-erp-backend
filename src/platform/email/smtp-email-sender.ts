import { Logger } from '@nestjs/common';
import nodemailer, { type Transporter } from 'nodemailer';
import { EmailSender, type EmailMessage } from './email-sender.js';

/** SMTP delivery: Mailpit locally, the Amazon SES SMTP endpoint when deployed. */
export class SmtpEmailSender extends EmailSender {
  private readonly logger = new Logger('Email');
  private readonly transport: Transporter;

  constructor(
    smtpUrl: string,
    private readonly from: string,
  ) {
    super();
    this.transport = nodemailer.createTransport(smtpUrl);
  }

  async send(message: EmailMessage): Promise<void> {
    await this.transport.sendMail({
      from: this.from,
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
    });
    this.logger.log({ template: message.template }, 'Email sent');
  }
}
