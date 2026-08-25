import { describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';

/**
 * Every way out of a dialog, and the one way in.
 *
 * Both pickers once declared a setup function called `open` alongside their
 * `open` prop. A setup binding wins over a prop of the same name in the
 * template, so `v-if="open"` tested a function: the dialog appeared the moment
 * the page loaded and no button could dismiss it. These tests exist so that
 * cannot come back unnoticed, for either picker.
 */

vi.mock('../src/lib/api', () => ({
  api: {
    files: {
      list: { query: vi.fn(async () => ({ entries: [] })) },
      read: { query: vi.fn(async () => ({ content: 'hello', modifiedAt: new Date(0) })) },
      write: { mutate: vi.fn(async () => ({ modifiedAt: new Date(0) })) },
    },
    system: {
      browse: {
        query: vi.fn(async () => ({
          path: 'C:\\',
          parent: null,
          entries: [],
          drives: ['C:\\'],
          selected: null,
          truncated: false,
        })),
      },
    },
  },
  describeError: (error: unknown) => String(error),
}));

const PathPicker = (await import('../src/components/PathPicker.vue')).default;
const ServerPathPicker = (await import('../src/components/ServerPathPicker.vue')).default;
const FileEditorDialog = (await import('../src/components/FileEditorDialog.vue')).default;
const PasswordConfirmDialog = (await import('../src/components/PasswordConfirmDialog.vue')).default;
const ConfirmDialog = (await import('../src/components/ConfirmDialog.vue')).default;
const SiteStorageDialog = (await import('../src/components/SiteStorageDialog.vue')).default;

const pickers = [
  {
    name: 'PathPicker',
    component: PathPicker,
    props: { modelValue: '', siteSlug: 'example', base: 'release' },
    dismissLabel: 'Cancel',
  },
  {
    name: 'ServerPathPicker',
    component: ServerPathPicker,
    props: { modelValue: '' },
    dismissLabel: 'Cancel',
  },
  {
    name: 'FileEditorDialog',
    component: FileEditorDialog,
    props: { siteSlug: 'example', path: 'public/index.html' },
    dismissLabel: 'Cancel',
  },
  {
    name: 'PasswordConfirmDialog',
    component: PasswordConfirmDialog,
    props: { title: 'Delete database?', description: 'This cannot be undone.' },
    dismissLabel: 'Cancel',
  },
  {
    name: 'ConfirmDialog',
    component: ConfirmDialog,
    props: { title: 'Set a new password?', description: 'The old one will stop working.' },
    dismissLabel: 'Cancel',
  },
  {
    name: 'SiteStorageDialog',
    component: SiteStorageDialog,
    props: { sourceKind: 'git', runtime: 'node', origin: 'https://example.com', published: true },
    dismissLabel: 'Close',
  },
] as const;

describe.each(pickers)('$name', ({ component, props, dismissLabel }) => {
  it('stays shut until it is asked to open', () => {
    const wrapper = mount(component, { props: { ...props, open: false } });

    expect(wrapper.find('[role="dialog"]').exists()).toBe(false);
  });

  it('opens when asked', () => {
    const wrapper = mount(component, { props: { ...props, open: true } });

    expect(wrapper.find('[role="dialog"]').exists()).toBe(true);
  });

  it('closes from the X in the corner', async () => {
    const wrapper = mount(component, { props: { ...props, open: true } });

    await wrapper.get('button[aria-label="Close"]').trigger('click');

    expect(wrapper.emitted('close')).toHaveLength(1);
  });

  it('closes from the button in the footer', async () => {
    const wrapper = mount(component, { props: { ...props, open: true } });
    const cancel = wrapper.findAll('button').find((button) => button.text() === dismissLabel);

    await cancel?.trigger('click');

    expect(wrapper.emitted('close')).toHaveLength(1);
  });

  it('closes when the backdrop behind it is clicked', async () => {
    const wrapper = mount(component, { props: { ...props, open: true } });

    await wrapper.get('.fixed').trigger('click');

    expect(wrapper.emitted('close')).toHaveLength(1);
  });

  it('closes on Escape, so there is a way out that needs no button at all', async () => {
    const wrapper = mount(component, { props: { ...props, open: true } });

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

    expect(wrapper.emitted('close')).toHaveLength(1);
  });

  it('stops listening for Escape once it is closed', async () => {
    const wrapper = mount(component, { props: { ...props, open: true } });
    await wrapper.setProps({ open: false });

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

    expect(wrapper.emitted('close')).toBeUndefined();
  });
});

describe('PasswordConfirmDialog confirmation', () => {
  it('emits the password entered by the user', async () => {
    const wrapper = mount(PasswordConfirmDialog, {
      props: {
        open: true,
        title: 'Delete database?',
        description: 'This cannot be undone.',
      },
    });

    await wrapper.get('input[type="password"]').setValue('current-password');
    await wrapper.get('form').trigger('submit');

    expect(wrapper.emitted('confirm')).toEqual([['current-password']]);
  });
});
