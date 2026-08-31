export interface RenderedPanelEmail {
  subject: string;
  text: string;
  html: string;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

function layout(input: {
  subject: string;
  title: string;
  intro: string;
  text: string;
  action?: { label: string; href: string };
  detail?: string;
}): RenderedPanelEmail {
  const title = escapeHtml(input.title);
  const intro = escapeHtml(input.intro);
  const detail = input.detail ? escapeHtml(input.detail) : null;
  const action = input.action
    ? `<p style="margin:28px 0"><a href="${escapeHtml(input.action.href)}" style="display:inline-block;background:#a855d6;color:#fff;text-decoration:none;font-weight:700;padding:13px 20px;border-radius:6px">${escapeHtml(input.action.label)}</a></p>`
    : '';

  return {
    subject: input.subject,
    text: `${input.title}\n\n${input.intro}${input.detail ? `\n\n${input.detail}` : ''}${input.action ? `\n\n${input.action.label}: ${input.action.href}` : ''}\n\nWinPanel`,
    html: `<!doctype html><html><body style="margin:0;background:#17151f;color:#f4f1f8;font-family:'Segoe UI',Arial,sans-serif"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="padding:32px 12px;background:#17151f"><tr><td align="center"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:580px;background:#24212d;border:1px solid #403947;border-radius:14px;overflow:hidden"><tr><td style="padding:0"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#302b3a"><tr><td style="padding:22px 28px"><table role="presentation" cellspacing="0" cellpadding="0"><tr><td style="width:34px;height:34px;background:#a855d6;border-radius:9px;color:#fff;text-align:center;font-size:17px;font-weight:800;line-height:34px">W</td><td style="padding-left:11px;color:#f4f1f8;font-size:20px;font-weight:700;letter-spacing:.01em">WinPanel</td></tr></table></td></tr></table></td></tr><tr><td style="padding:34px 28px"><p style="margin:0 0 11px;color:#d8adff;font-size:11px;font-weight:700;letter-spacing:.16em;text-transform:uppercase">WinPanel notification</p><h1 style="margin:0 0 16px;font-size:26px;line-height:1.2;color:#f4f1f8">${title}</h1><p style="margin:0;font-size:16px;line-height:1.6;color:#bcb4c6">${intro}</p>${detail ? `<p style="margin:20px 0 0;padding:14px 16px;border-left:3px solid #a855d6;background:#302b3a;font-size:15px;line-height:1.5;color:#bcb4c6">${detail}</p>` : ''}${action}</td></tr><tr><td style="padding:18px 28px;border-top:1px solid #403947;color:#82798d;font-size:12px;line-height:1.5">This message was sent by the WinPanel control panel on your server. If you did not expect it, contact the server owner.</td></tr></table></td></tr></table></body></html>`,
  };
}

export function panelTestEmail(): RenderedPanelEmail {
  return layout({
    subject: 'WinPanel test email',
    title: 'Panel email is working',
    intro: 'This test message confirms that WinPanel can send panel notifications.',
    text: 'This test message confirms that WinPanel can send panel notifications.',
    detail: 'The sender settings and delivery connection are working.',
  });
}

export function emailVerificationEmail(input: {
  username: string;
  link: string;
}): RenderedPanelEmail {
  return layout({
    subject: 'Confirm your WinPanel email address',
    title: 'Confirm your email address',
    intro: `Hello ${input.username}, confirm this address to use it for password recovery and account alerts.`,
    text: `Hello ${input.username}, confirm this address to use it for password recovery and account alerts.`,
    action: { label: 'Confirm email address', href: input.link },
    detail: 'This link expires in 24 hours and can be used only once.',
  });
}

export function passwordResetEmail(input: {
  username: string;
  link: string;
}): RenderedPanelEmail {
  return layout({
    subject: 'Reset your WinPanel password',
    title: 'Reset your password',
    intro: `Hello ${input.username}, someone requested a new password for your WinPanel account.`,
    text: `Hello ${input.username}, someone requested a new password for your WinPanel account.`,
    action: { label: 'Choose a new password', href: input.link },
    detail: 'This link expires in 30 minutes and can be used only once. Your password will not be sent by email.',
  });
}

export function passwordChangedEmail(input: { username: string }): RenderedPanelEmail {
  return layout({
    subject: 'Your WinPanel password changed',
    title: 'Password changed',
    intro: `Hello ${input.username}, your WinPanel password was changed successfully.`,
    text: `Hello ${input.username}, your WinPanel password was changed successfully.`,
    detail: 'All other signed-in browsers were signed out. If you did not make this change, contact the server owner immediately.',
  });
}

export function passwordResetByAdminEmail(input: {
  username: string;
  administrator: string;
}): RenderedPanelEmail {
  return layout({
    subject: 'Your WinPanel password was reset',
    title: 'Password reset by an administrator',
    intro:
      `Hello ${input.username}, ${input.administrator} reset the password for your WinPanel account.`,
    text:
      `Hello ${input.username}, ${input.administrator} reset the password for your WinPanel account.`,
    detail:
      'All signed-in browsers were signed out. If you did not expect this change, contact the server owner immediately.',
  });
}

export function websiteOutageEmail(input: {
  username: string;
  siteName: string;
  domain: string | null;
  recovered: boolean;
}): RenderedPanelEmail {
  const state = input.recovered ? 'is reachable again' : 'may be offline';
  return layout({
    subject: input.recovered
      ? `${input.siteName} is reachable again`
      : `${input.siteName} may be offline`,
    title: input.recovered ? 'Website recovered' : 'Website may be offline',
    intro: `Hello ${input.username}, ${input.siteName} ${state}.`,
    text: `Hello ${input.username}, ${input.siteName} ${state}.`,
    detail: input.domain ? `Address: ${input.domain}` : 'The website has no public domain configured.',
  });
}
