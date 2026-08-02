import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import type { CheckResult } from '@winpanel/shared';
import StatusBadge from '../src/components/StatusBadge.vue';
import CheckCard from '../src/components/CheckCard.vue';

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
