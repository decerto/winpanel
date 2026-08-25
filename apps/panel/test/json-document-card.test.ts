import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import JsonDocumentCard from '../src/components/JsonDocumentCard.vue';

const row = {
  id: '{"$oid":"507f1f77bcf86cd799439011"}',
  json: '{\n  "title": "<script>",\n  "published": true,\n  "count": 3,\n  "summary": null\n}',
  truncated: false,
};

describe('JsonDocumentCard', () => {
  it('highlights JSON tokens and escapes document content', () => {
    const wrapper = mount(JsonDocumentCard, { props: { document: row } });
    const html = wrapper.find('pre').html();

    expect(html).toContain('json-key');
    expect(html).toContain('json-string');
    expect(html).toContain('json-boolean');
    expect(html).toContain('json-number');
    expect(html).toContain('json-null');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
  });

  it('validates and emits an edited document', async () => {
    const wrapper = mount(JsonDocumentCard, { props: { document: row } });

    await wrapper.find('button').trigger('click');
    await wrapper.find('textarea').setValue('{"title":"Updated"}');
    await wrapper
      .findAll('button')
      .find((button) => button.text().includes('Update'))
      ?.trigger('click');

    expect(wrapper.emitted('save')).toEqual([[row.id, '{"title":"Updated"}']]);
  });

  it('keeps the editor open when the draft is not a JSON object', async () => {
    const wrapper = mount(JsonDocumentCard, { props: { document: row } });

    await wrapper.find('button').trigger('click');
    await wrapper.find('textarea').setValue('[]');
    await wrapper
      .findAll('button')
      .find((button) => button.text().includes('Update'))
      ?.trigger('click');

    expect(wrapper.text()).toContain('A document has to be a JSON object.');
    expect(wrapper.find('textarea').exists()).toBe(true);
    expect(wrapper.emitted('save')).toBeUndefined();
  });
});