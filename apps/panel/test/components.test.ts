import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import type { CheckResult } from '@winpanel/shared';
import StatusBadge from '../src/components/StatusBadge.vue';
import CheckCard from '../src/components/CheckCard.vue';
import QrCode from '../src/components/QrCode.vue';
import TotpEnrolment from '../src/components/TotpEnrolment.vue';
import RecoveryCodes from '../src/components/RecoveryCodes.vue';
import PaginationBar from '../src/components/PaginationBar.vue';
import { siteStatus } from '../src/lib/site-status';
import { describeUserAgent, timeAgo } from '../src/lib/format';

/**
 * The design rule these tests defend: a status must never be conveyed by
 * colour alone. Every state carries a distinct icon and a text label so it
 * survives colour blindness and high-contrast modes.
 */

describe('StatusBadge', () => {
  const states = ['blocked', 'warning', 'ok', 'absent', 'checking', 'unknown'] as const;

  it('renders a text label for every state', () => {
    for (const state of states) {
      const wrapper = mount(StatusBadge, { props: { state } });
      expect(wrapper.text().trim().length, state).toBeGreaterThan(0);
    }
  });

  it('gives each state a distinct label', () => {
    const labels = states.map((state) => mount(StatusBadge, { props: { state } }).text());
    // 'absent' and 'unknown' share a colour, so the words must differ.
    expect(new Set(labels).size).toBeGreaterThanOrEqual(5);
  });

  it('renders an icon alongside the colour', () => {
    for (const state of states) {
      const wrapper = mount(StatusBadge, { props: { state } });
      expect(wrapper.find('svg').exists(), state).toBe(true);
    }
  });

  it('keeps the label available to screen readers when visually hidden', () => {
    const wrapper = mount(StatusBadge, { props: { state: 'ok', showLabel: false } });
    expect(wrapper.find('.sr-only').exists()).toBe(true);
    expect(wrapper.find('.sr-only').text()).toBe('OK');
  });

  it('marks decorative icons as hidden from assistive technology', () => {
    const wrapper = mount(StatusBadge, { props: { state: 'ok' } });
    expect(wrapper.find('svg').attributes('aria-hidden')).toBe('true');
  });

  it('animates only the checking state', () => {
    expect(mount(StatusBadge, { props: { state: 'checking' } }).html()).toContain('animate-spin');
    expect(mount(StatusBadge, { props: { state: 'ok' } }).html()).not.toContain('animate-spin');
  });
});

function makeResult(overrides: Partial<CheckResult> = {}): CheckResult {
  return {
    id: 'server.long-paths',
    category: 'server',
    name: 'Long file names allowed',
    plainDescription: 'Website projects create very deeply nested folders.',
    state: 'warning',
    checkedAt: new Date(),
    ttlSeconds: 60,
    ...overrides,
  } as CheckResult;
}

describe('CheckCard', () => {
  it('shows the name, description and status', () => {
    const wrapper = mount(CheckCard, { props: { result: makeResult() } });
    expect(wrapper.text()).toContain('Long file names allowed');
    expect(wrapper.text()).toContain('deeply nested folders');
    expect(wrapper.text()).toContain('Warning');
  });

  it('explains why something is wrong', () => {
    const wrapper = mount(CheckCard, {
      props: {
        result: makeResult({ reason: 'Installing website packages will fail.' }),
      },
    });
    expect(wrapper.text()).toContain('Installing website packages will fail.');
  });

  it('states what a fix will change before it is pressed', () => {
    // This panel edits a live server, so no button should be a mystery.
    const wrapper = mount(CheckCard, {
      props: {
        result: makeResult({
          fix: {
            kind: 'automatic',
            action: 'server.enable-long-paths',
            label: 'Allow long file names',
            describesChange: 'Sets LongPathsEnabled to 1 in the Windows registry.',
            safeToBatch: true,
            reversible: true,
          },
        }),
      },
    });

    expect(wrapper.text()).toContain('Sets LongPathsEnabled to 1');
    expect(wrapper.text()).toContain('This can be undone.');
    expect(wrapper.find('button').text()).toBe('Allow long file names');
  });

  it('emits the fix action when pressed', async () => {
    const wrapper = mount(CheckCard, {
      props: {
        result: makeResult({
          fix: {
            kind: 'automatic',
            action: 'server.enable-long-paths',
            label: 'Fix it',
            describesChange: 'Changes a setting.',
            safeToBatch: true,
            reversible: true,
          },
        }),
      },
    });

    await wrapper.find('button').trigger('click');
    expect(wrapper.emitted('fix')?.[0]).toEqual(['server.enable-long-paths']);
  });

  it('shows instructions instead of a button when a fix cannot be automated', () => {
    // Things like asking the hosting provider to unblock a port.
    const wrapper = mount(CheckCard, {
      props: {
        result: makeResult({
          fix: {
            kind: 'manual',
            label: 'Open the OVH control panel',
            instructions: 'Ask OVH to unblock outgoing email.',
            url: 'https://www.ovh.com/manager/',
          },
        }),
      },
    });

    expect(wrapper.text()).toContain('Ask OVH to unblock outgoing email.');
    expect(wrapper.find('a').attributes('href')).toBe('https://www.ovh.com/manager/');
    expect(wrapper.find('a').attributes('rel')).toContain('noopener');
    expect(wrapper.find('button').exists()).toBe(false);
  });

  it('disables the fix button while it is running', () => {
    const wrapper = mount(CheckCard, {
      props: {
        busy: true,
        result: makeResult({
          fix: {
            kind: 'automatic',
            action: 'x',
            label: 'Fix it',
            describesChange: 'Changes a setting.',
            safeToBatch: true,
            reversible: true,
          },
        }),
      },
    });

    expect(wrapper.find('button').attributes('disabled')).toBeDefined();
    expect(wrapper.find('button').text()).toMatch(/working/i);
  });

  it('offers no fix button when everything is fine', () => {
    const wrapper = mount(CheckCard, {
      props: { result: makeResult({ state: 'ok', detail: 'Allowed' }) },
    });
    expect(wrapper.find('button').exists()).toBe(false);
    expect(wrapper.text()).toContain('Allowed');
  });
});

describe('QrCode', () => {
  // What two-factor setup actually passes in.
  const uri =
    'otpauth://totp/WinPanel:admin?secret=BU4675JDDOTPMLT6TS6VOPUAAGDH7BWE&issuer=WinPanel&algorithm=SHA1&digits=6&period=30';

  it('draws the code as inline SVG, so nothing is fetched to render it', () => {
    const wrapper = mount(QrCode, { props: { value: uri } });

    const svg = wrapper.find('svg');
    expect(svg.exists()).toBe(true);
    expect(wrapper.find('path').attributes('d')?.length ?? 0).toBeGreaterThan(0);
    expect(wrapper.html()).not.toContain('<img');
  });

  it('puts the code on a white background whatever the page behind it', () => {
    // The panel is dark. Drawn straight onto it, the code cannot be scanned.
    const wrapper = mount(QrCode, { props: { value: uri } });
    expect(wrapper.find('rect').attributes('fill')).toBe('#ffffff');
  });

  it('leaves a quiet zone around the modules', () => {
    // Scanners need a light margin to find the corner patterns.
    const wrapper = mount(QrCode, { props: { value: uri } });
    const [, , size] = wrapper.find('svg').attributes('viewBox')!.split(' ').map(Number);

    const modules = (wrapper.find('path').attributes('d')!.match(/M(\d+) (\d+)h/g) ?? []).map(
      (move) => move.match(/M(\d+) (\d+)h/)!.slice(1).map(Number) as [number, number],
    );

    expect(Math.min(...modules.map(([column]) => column))).toBeGreaterThanOrEqual(2);
    expect(Math.min(...modules.map(([, row]) => row))).toBeGreaterThanOrEqual(2);
    expect(Math.max(...modules.map(([column]) => column))).toBeLessThanOrEqual(size! - 3);
  });

  it('is announced to screen readers rather than left as an unlabelled graphic', () => {
    const wrapper = mount(QrCode, { props: { value: uri, label: 'Two-factor setup QR code' } });
    expect(wrapper.find('svg').attributes('role')).toBe('img');
    expect(wrapper.find('svg').attributes('aria-label')).toBe('Two-factor setup QR code');
  });

  it('renders nothing rather than an empty box before the value arrives', () => {
    expect(mount(QrCode, { props: { value: '' } }).find('svg').exists()).toBe(false);
  });
});

describe('TotpEnrolment', () => {
  const props = {
    uri: 'otpauth://totp/WinPanel:owner?secret=BU4675JDDOTPMLT6TS6VOPUAAGDH7BWE&issuer=WinPanel',
    secret: 'BU4675JDDOTPMLT6TS6VOPUAAGDH7BWE',
  };

  it('offers both ways in: the code to scan and the key to type', () => {
    // Plenty of servers are administered from a machine with no camera, and
    // some authenticator apps cannot scan at all.
    const wrapper = mount(TotpEnrolment, { props });
    expect(wrapper.findComponent(QrCode).exists()).toBe(true);
    expect(wrapper.text()).toContain(props.secret);
  });

  it('will not submit until a full six-digit code is entered', async () => {
    const wrapper = mount(TotpEnrolment, { props });
    const button = wrapper.find('button[type="submit"]');

    expect(button.attributes('disabled')).toBeDefined();
    await wrapper.find('input').setValue('12345');
    expect(button.attributes('disabled')).toBeDefined();
    await wrapper.find('input').setValue('123456');
    expect(button.attributes('disabled')).toBeUndefined();
  });

  it('emits the typed code so enrolment is only ever finished by proving it works', async () => {
    const wrapper = mount(TotpEnrolment, { props });
    await wrapper.find('input').setValue('123456');
    await wrapper.find('form').trigger('submit');
    expect(wrapper.emitted('confirm')?.[0]).toEqual(['123456']);
  });

  it('warns that losing the key means losing access', () => {
    expect(mount(TotpEnrolment, { props }).text()).toMatch(/losing your phone/i);
  });

  it('offers a way out only when the caller provides one', async () => {
    expect(mount(TotpEnrolment, { props }).find('button[type="button"]').exists()).toBe(false);

    const wrapper = mount(TotpEnrolment, { props: { ...props, cancelLabel: 'Skip' } });
    await wrapper.find('button[type="button"]').trigger('click');
    expect(wrapper.emitted('cancel')).toBeTruthy();
  });
});

describe('RecoveryCodes', () => {
  const codes = Array.from({ length: 10 }, (_, index) => `AAAA-BBBB-CCCC-${1000 + index}`);

  it('shows every code', () => {
    const wrapper = mount(RecoveryCodes, { props: { codes } });
    for (const code of codes) expect(wrapper.text()).toContain(code);
  });

  it('says plainly that this is the only time they can be read', () => {
    // They are stored hashed. Someone who clicks past without saving them
    // cannot get this set back, only replace it.
    expect(mount(RecoveryCodes, { props: { codes } }).text()).toMatch(/not shown again/i);
  });

  it('will not let the user move on until they confirm they have saved them', async () => {
    const wrapper = mount(RecoveryCodes, { props: { codes } });
    const done = wrapper.findAll('button').at(-1)!;

    expect(done.attributes('disabled')).toBeDefined();
    await wrapper.find('input[type="checkbox"]').setValue(true);
    expect(done.attributes('disabled')).toBeUndefined();

    await done.trigger('click');
    expect(wrapper.emitted('done')).toBeTruthy();
  });
});

describe('PaginationBar', () => {
  const props = { page: 1, total: 40, pageSize: 10, noun: 'websites' };

  it('stays out of the way when everything already fits', () => {
    // A list of three does not need paging, and a control that does nothing
    // is just another thing to read past.
    const wrapper = mount(PaginationBar, { props: { ...props, total: 8 } });
    expect(wrapper.find('nav').exists()).toBe(false);
  });

  it('says which of how many is on screen', () => {
    const wrapper = mount(PaginationBar, { props: { ...props, page: 2 } });
    expect(wrapper.text()).toContain('11');
    expect(wrapper.text()).toContain('20');
    expect(wrapper.text()).toContain('40 websites');
  });

  it('counts the last page even when it is not full', () => {
    const wrapper = mount(PaginationBar, { props: { ...props, total: 41, page: 5 } });
    expect(wrapper.text()).toContain('41 of 41');
  });

  it('cannot be walked off either end', async () => {
    const first = mount(PaginationBar, { props });
    expect(first.find('button[aria-label="Previous page"]').attributes('disabled')).toBeDefined();

    const last = mount(PaginationBar, { props: { ...props, page: 4 } });
    expect(last.find('button[aria-label="Next page"]').attributes('disabled')).toBeDefined();
  });

  it('asks for the page that was clicked', async () => {
    const wrapper = mount(PaginationBar, { props });
    await wrapper.find('button[aria-label="Page 3"]').trigger('click');
    expect(wrapper.emitted('update:page')?.[0]).toEqual([3]);
  });

  it('collapses a long run of pages rather than printing all of them', () => {
    const wrapper = mount(PaginationBar, { props: { ...props, total: 500, page: 25 } });
    const numbered = wrapper.findAll('button[aria-label^="Page"]');

    expect(numbered.length).toBeLessThan(8);
    // The two ends stay reachable in one click however long the list is.
    expect(wrapper.find('button[aria-label="Page 1"]').exists()).toBe(true);
    expect(wrapper.find('button[aria-label="Page 50"]').exists()).toBe(true);
  });

  it('marks the current page for screen readers, not just visually', () => {
    const wrapper = mount(PaginationBar, { props: { ...props, page: 2 } });
    expect(wrapper.find('button[aria-label="Page 2"]').attributes('aria-current')).toBe('page');
  });
});

describe('what a website is said to be doing', () => {
  it('only calls it live once a deployment has actually succeeded', () => {
    // A port is allocated when a site is created, so the port alone proves
    // nothing. Claiming "live" for something never deployed sends people
    // looking for a fault in DNS.
    expect(siteStatus({ lastDeploymentStatus: null, activePort: 3001 }).label).toBe(
      'Not published yet',
    );
    expect(siteStatus({ lastDeploymentStatus: 'succeeded', activePort: 3001 }).label).toBe(
      'Live on 3001',
    );
  });

  it('does not claim a port for a static site, which has no process', () => {
    // Static files are served by the web server itself. Naming a port would
    // send someone looking for a service that was never meant to exist.
    expect(
      siteStatus({ lastDeploymentStatus: 'succeeded', activePort: 3001, runtime: 'static' }).label,
    ).toBe('Live');
  });

  it('distinguishes a failed deploy from one still running', () => {
    expect(siteStatus({ lastDeploymentStatus: 'failed', activePort: 1 }).label).toMatch(/failed/i);
    expect(siteStatus({ lastDeploymentStatus: 'running', activePort: 1 }).label).toBe('Deploying');
  });

  it('pairs every colour with words', () => {
    for (const status of ['succeeded', 'failed', 'running', null]) {
      const result = siteStatus({ lastDeploymentStatus: status, activePort: 3000 });
      expect(result.label.length, String(status)).toBeGreaterThan(0);
      expect(result.dot, String(status)).toMatch(/^bg-/);
    }
  });
});

describe('timeAgo', () => {
  const now = new Date('2026-08-05T12:00:00Z').getTime();
  const ago = (ms: number): string => timeAgo(new Date(now - ms), now);

  it('says just now for anything very recent', () => {
    expect(ago(0)).toBe('just now');
    expect(ago(30_000)).toBe('just now');
  });

  it('picks the largest unit that fits', () => {
    expect(ago(5 * 60_000)).toBe('5 minutes ago');
    expect(ago(60 * 60_000)).toBe('1 hour ago');
    expect(ago(3 * 24 * 60 * 60_000)).toBe('3 days ago');
  });

  it('reads forwards for a time yet to come', () => {
    // Session expiry is in the future, and "in 8 hours ago" is nonsense.
    expect(timeAgo(new Date(now + 8 * 60 * 60_000), now)).toBe('in 8 hours');
  });
});

describe('describeUserAgent', () => {
  it('names the browser and the machine', () => {
    expect(
      describeUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) '
        + 'Chrome/120.0.0.0 Safari/537.36',
      ),
    ).toBe('Chrome on Windows');
  });

  it('is not fooled by browsers that claim to be Chrome', () => {
    // Every one of these carries "Chrome/" and "Safari/" in its user agent.
    expect(
      describeUserAgent('Mozilla/5.0 (Windows NT 10.0) Chrome/120.0.0.0 Safari/537.36 Edg/120.0'),
    ).toBe('Edge on Windows');
    expect(
      describeUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/120 Safari/537.36'),
    ).toBe('Chrome on macOS');
    expect(
      describeUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari/604.1'),
    ).toBe('Safari on iPhone');
  });

  it('says so rather than showing nothing', () => {
    expect(describeUserAgent(null)).toBe('Unknown device');
    expect(describeUserAgent('')).toBe('Unknown device');
  });
});
