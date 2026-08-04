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

const pickers = [
  {
    name: 'PathPicker',
    component: PathPicker,
    props: { modelValue: '', siteSlug: 'example', base: 'release' },
  },
  {
    name: 'ServerPathPicker',
    component: ServerPathPicker,
    props: { modelValue: '' },
  },
  {
    name: 'FileEditorDialog',
    component: FileEditorDialog,
    props: { siteSlug: 'example', path: 'public/index.html' },
  },
] as const;

describe.each(pickers)('$name', ({ component, props }) => {
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

  it('closes from the Cancel button', async () => {
    const wrapper = mount(component, { props: { ...props, open: true } });
    const cancel = wrapper.findAll('button').find((button) => button.text() === 'Cancel');

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
