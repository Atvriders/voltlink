// R4: auth coverage — SMTP branch of sendMail (117-118). Nodemailer is mocked
// at the module boundary so the transporter path resolves without a real SMTP
// server. Runs in its own fork with SMTP_URL configured.
const hoisted = vi.hoisted(() => {
  process.env.NODE_ENV = 'test';
  process.env.MAIL_TO_CONSOLE = 'false';
  process.env.SMTP_URL = 'smtp://127.0.0.1:1025';
  return { sendMailMock: vi.fn() };
});
void hoisted;

vi.mock('nodemailer', () => ({
  default: { createTransport: () => ({ sendMail: hoisted.sendMailMock }) },
}));

import { describe, expect, it, vi } from 'vitest';
import { sendMail } from '../src/auth/service';

describe('sendMail smtp branch', () => {
  it('delivers via the configured transporter and reports smtp', async () => {
    hoisted.sendMailMock.mockResolvedValue({ messageId: 'm-1' });
    const res = await sendMail({
      to: 'someone@example.com',
      subject: 'Subject',
      text: 'text',
      html: '<p>html</p>',
    });
    expect(res).toEqual({ sent: true, detail: 'smtp' });
    expect(hoisted.sendMailMock).toHaveBeenCalledTimes(1);
    expect(hoisted.sendMailMock.mock.calls[0]![0]).toMatchObject({
      to: 'someone@example.com',
      subject: 'Subject',
    });
    // The transporter is cached across calls.
    await sendMail({
      to: 'again@example.com',
      subject: 'Subject',
      text: 'text',
      html: '<p>html</p>',
    });
    expect(hoisted.sendMailMock).toHaveBeenCalledTimes(2);
  });
});
