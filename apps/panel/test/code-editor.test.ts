import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import CodeEditor from '../src/components/CodeEditor.vue';

/**
 * The editor exists because config files are long.
 *
 * Project Zomboid's settings file is roughly a thousand lines, and the panel
 * used to offer a five-row box for it. These tests hold the two things that
 * made it usable: a gutter whose numbers match the text beside them, and a
 * find and replace that changes every occurrence and nothing else.
 */

const sample = ['one', 'two', 'three', 'four'].join('\n');

function editor(content = sample) {
  return mount(CodeEditor, { props: { modelValue: content, 'onUpdate:modelValue': () => {} } });
}

describe('CodeEditor', () => {
  it('numbers every line, and only the lines there are', () => {
    const gutter = editor().get('[aria-hidden="true"] pre').text();

    expect(gutter.split('\n')).toEqual(['1', '2', '3', '4']);
  });

  it('keeps counting as the text grows', async () => {
    const wrapper = editor();

    await wrapper.setProps({ modelValue: `${sample}\nfive` });

    expect(wrapper.get('[aria-hidden="true"] pre').text().split('\n').at(-1)).toBe('5');
  });

  it('reports where the caret is, the way an error message counts', async () => {
    const wrapper = editor();
    const area = wrapper.get('textarea');
    (area.element as HTMLTextAreaElement).setSelectionRange(6, 6);

    await area.trigger('click');

    expect(wrapper.text()).toContain('Ln 2, Col 3');
  });

  it('counts matches once a search is open', async () => {
    const wrapper = editor('alpha beta alpha');

    await wrapper.findAll('button').find((button) => button.text().includes('Find'))?.trigger('click');
    await wrapper.get('input[aria-label="Find"]').setValue('alpha');

    expect(wrapper.text()).toContain('1 of 2');
  });

  it('is case-insensitive until asked otherwise', async () => {
    const wrapper = editor('Alpha alpha');

    await wrapper.findAll('button').find((button) => button.text().includes('Find'))?.trigger('click');
    await wrapper.get('input[aria-label="Find"]').setValue('alpha');
    expect(wrapper.text()).toContain('1 of 2');

    await wrapper.get('button[aria-label="Match case"]').trigger('click');
    expect(wrapper.text()).toContain('1 of 1');
  });

  it('treats a search as literal text unless the regex switch is on', async () => {
    const wrapper = editor('a.c abc');

    await wrapper.findAll('button').find((button) => button.text().includes('Find'))?.trigger('click');
    await wrapper.get('input[aria-label="Find"]').setValue('a.c');
    expect(wrapper.text()).toContain('1 of 1');

    await wrapper.get('button[aria-label="Use a regular expression"]').trigger('click');
    expect(wrapper.text()).toContain('1 of 2');
  });

  /*
   * Replacing front to back would shift the offsets of every hit still to
   * come, which is how a replace-all silently corrupts the tail of a file.
   */
  it('replaces every match without disturbing the rest of the file', async () => {
    const wrapper = mount(CodeEditor, {
      props: {
        modelValue: 'Mods=A\nWorkshopItems=A\nPublicName=A team',
        'onUpdate:modelValue': (value: string) => wrapper.setProps({ modelValue: value }),
      },
    });

    await wrapper.findAll('button').find((button) => button.text().includes('Replace'))?.trigger('click');
    await wrapper.get('input[aria-label="Find"]').setValue('=A');
    await wrapper.get('input[aria-label="Replace with"]').setValue('=B');
    await wrapper.findAll('button').filter((button) => button.text().trim() === 'All')[0]?.trigger('click');

    expect(wrapper.props('modelValue')).toBe('Mods=B\nWorkshopItems=B\nPublicName=B team');
  });

  it('never reports thousands of hits for a pattern that matches nothing', async () => {
    const wrapper = editor('abc');

    await wrapper.findAll('button').find((button) => button.text().includes('Find'))?.trigger('click');
    await wrapper.get('button[aria-label="Use a regular expression"]').trigger('click');
    await wrapper.get('input[aria-label="Find"]').setValue('x*');

    expect(wrapper.text()).toContain('No matches');
  });

  it('asks to be saved when Ctrl+S is pressed, rather than letting the browser have it', async () => {
    const wrapper = editor();

    await wrapper.get('textarea').trigger('keydown', { key: 's', ctrlKey: true });

    expect(wrapper.emitted('save')).toHaveLength(1);
  });

  it('hides the numbers while wrapping, because a wrapped line is several rows', async () => {
    const wrapper = editor();
    expect(wrapper.find('[aria-hidden="true"] pre').exists()).toBe(true);

    await wrapper.findAll('button').find((button) => button.text().includes('Wrap'))?.trigger('click');

    expect(wrapper.find('[aria-hidden="true"] pre').exists()).toBe(false);
  });
});
