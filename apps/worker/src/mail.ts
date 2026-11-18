import nodemailer, { type Transporter } from 'nodemailer';
import type { MailMessage, MailSender } from '@dmc/contracts';
import type { Logger } from '@dmc/platform';

/** Sends through an SMTP server. Pass `transport` to use another nodemailer transport (tests do). */
export class SmtpMailer implements MailSender {
  private readonly t: Transporter;
  constructor(private readonly opts: { host: string; port: number; secure: boolean; user?: string; password?: string; from: string; transport?: Transporter }) {
    this.t = opts.transport ?? nodemailer.createTransport({ host: opts.host, port: opts.port, secure: opts.secure, ...(opts.user ? { auth: { user: opts.user, pass: opts.password ?? '' } } : {}) });
  }
  async send(m: MailMessage): Promise<void> {
    await this.t.sendMail({ from: this.opts.from, to: m.to, subject: m.subject, text: m.text, headers: { 'X-DMC-Event': m.key } });
  }
}

/** No SMTP configured: the message is a log line. */
export const logMailer = (log: Logger): MailSender => ({ async send(m) { log.info('email (not sent: no SMTP configured)', { to: m.to, subject: m.subject, key: m.key }); } });

/** A transport that builds the message and sends nothing: for tests. */
export const jsonTransport = (): Transporter => nodemailer.createTransport({ jsonTransport: true });
