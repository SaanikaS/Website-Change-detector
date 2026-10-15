import nodemailer from 'nodemailer';
import { config } from './config.js';
import { log } from './util.js';

let transporter;
function mailer() {
  if (!config.smtp.host) return null;
  transporter ??= nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
  });
  return transporter;
}

/** Sends one message to one channel. Throws on failure so the queue retries with backoff. */
export async function sendNotification({ channel, subject, text }) {
  switch (channel.type) {
    case 'email': {
      const t = mailer();
      if (!t) return log('SMTP not configured; skipping email to', channel.target);
      await t.sendMail({ from: config.smtp.from, to: channel.target, subject, text });
      return;
    }
    case 'discord': {
      const res = await fetch(channel.target, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          username: 'Website Change Detector',
          content: `**${subject}**\n${text}`.slice(0, 1900),
        }),
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) throw new Error(`Discord webhook returned HTTP ${res.status}`);
      return;
    }
    case 'telegram': {
      if (!config.telegramBotToken) return log('TELEGRAM_BOT_TOKEN not set; skipping Telegram message');
      const res = await fetch(`https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: channel.target, text: `${subject}\n\n${text}`.slice(0, 4000) }),
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) throw new Error(`Telegram API returned HTTP ${res.status}`);
      return;
    }
    default:
      throw new Error(`Unknown channel type ${channel.type}`);
  }
}
