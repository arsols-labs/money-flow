import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { compactComment, ReceiptUrlLink } from '../src/ui/ReceiptUrlLink.jsx';
import { parseHttpUrl } from '../src/shared/http-url';
import i18n from '../src/ui/i18n.js';

describe('parseHttpUrl / ReceiptUrlLink (issue #555)', () => {
  it('принимает http(s) и отвергает javascript:', () => {
    expect(parseHttpUrl(' https://suf.purs.gov.rs/v/?vl=abc ')).toBe('https://suf.purs.gov.rs/v/?vl=abc');
    expect(parseHttpUrl('http://example.com/fiscal')).toBe('http://example.com/fiscal');
    expect(parseHttpUrl('javascript:alert(1)')).toBeNull();
    expect(parseHttpUrl('data:text/html,hi')).toBeNull();
    expect(parseHttpUrl('')).toBeNull();
  });

  it('рисует короткую i18n-подпись, а не сам URL', () => {
    const url = 'https://suf.purs.gov.rs/v/?vl=' + 'A'.repeat(120);
    const html = renderToStaticMarkup(React.createElement(ReceiptUrlLink, { url }));
    expect(html).toContain(`>${i18n.t('common.link')}</a>`);
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain(`href="${url}"`);
    expect(html).not.toMatch(new RegExp(`>[^<]*${url.slice(0, 40)}`));
  });

  it('не рендерит ничего для опасного или пустого URL', () => {
    expect(renderToStaticMarkup(React.createElement(ReceiptUrlLink, { url: 'javascript:alert(1)' }))).toBe('');
    expect(renderToStaticMarkup(React.createElement(ReceiptUrlLink, { url: '' }))).toBe('');
  });

  it('обрезает длинный комментарий в мета-линии', () => {
    expect(compactComment('  коротко  ')).toBe('коротко');
    expect(compactComment('x'.repeat(90)).endsWith('…')).toBe(true);
    expect(compactComment('x'.repeat(90)).length).toBe(80);
  });
});
