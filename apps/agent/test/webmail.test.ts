import { describe, expect, it } from 'vitest';
import { sanitiseHtml } from '../src/api/routers/webmail.js';
import { WebmailSessions } from '../src/mail/webmail-sessions.js';

/**
 * Webmail shows attacker-supplied HTML inside the panel that administers the
 * whole server, so the two things that stand between a message and that panel
 * — the sanitiser and the credential store — are tested directly.
 */

describe('sanitiseHtml', () => {
  it('removes scripts and their contents', () => {
    expect(sanitiseHtml('<p>hi</p><script>fetch("/evil")</script>')).toBe('<p>hi</p>');
  });

  it('removes event handlers however they are quoted', () => {
    expect(sanitiseHtml('<img src="a.png" onerror=alert(1)>')).toBe('<img src="a.png">');
    expect(sanitiseHtml('<div ONCLICK="x()">a</div>')).toBe('<div>a</div>');
  });

  it('defuses javascript links', () => {
    expect(sanitiseHtml('<a href="javascript:alert(1)">go</a>')).toBe('<a href="#">go</a>');
  });

  it('removes frames, which could load the panel itself', () => {
    expect(sanitiseHtml('<iframe src="/settings"></iframe><p>x</p>')).toBe('<p>x</p>');
  });

  it('leaves ordinary formatting alone', () => {
    const html = '<p><strong>Invoice</strong> attached. <a href="https://x.test">View</a></p>';
    expect(sanitiseHtml(html)).toBe(html);
  });
});

describe('WebmailSessions', () => {
  it('hands back the credentials for a token it issued', () => {
    const sessions = new WebmailSessions();
    const { token } = sessions.open({ address: 'a@example.com', password: 'secret' });

    expect(sessions.get(token)).toEqual({ address: 'a@example.com', password: 'secret' });
  });

  it('does not recognise a token it never issued', () => {
    expect(new WebmailSessions().get('made-up')).toBeNull();
  });

  it('forgets a sitting that has been idle too long', () => {
    let now = 0;
    const sessions = new WebmailSessions(() => now);
    const { token } = sessions.open({ address: 'a@example.com', password: 'secret' });

    now += 61 * 60 * 1000;
    expect(sessions.get(token)).toBeNull();
  });

  it('keeps a sitting alive while it is being used', () => {
    let now = 0;
    const sessions = new WebmailSessions(() => now);
    const { token } = sessions.open({ address: 'a@example.com', password: 'secret' });

    for (let step = 0; step < 5; step++) {
      now += 50 * 60 * 1000;
      expect(sessions.get(token)).not.toBeNull();
    }
  });

  it('ends a sitting when it is closed', () => {
    const sessions = new WebmailSessions();
    const { token } = sessions.open({ address: 'a@example.com', password: 'secret' });

    sessions.close(token);
    expect(sessions.get(token)).toBeNull();
  });
});
