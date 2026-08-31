import { describe, expect, it } from 'vitest';
import { emailVerificationEmail, panelTestEmail } from '../src/mail/templates.js';

describe('panel email templates', () => {
  it('uses the panel brand for the test email', () => {
    const message = panelTestEmail();

    expect(message.subject).toBe('WinPanel test email');
    expect(message.text).toContain('Panel email is working');
    expect(message.html).toContain('#17151f');
    expect(message.html).toContain('#a855d6');
    expect(message.html).not.toContain('#d96c38');
  });

  it('escapes account details while keeping the branded action button', () => {
    const message = emailVerificationEmail({
      username: 'A & B',
      link: 'https://example.test/verify?token=a&next=b',
    });

    expect(message.html).toContain('A &amp; B');
    expect(message.html).toContain('href="https://example.test/verify?token=a&amp;next=b"');
    expect(message.html).toContain('background:#a855d6');
  });
});
