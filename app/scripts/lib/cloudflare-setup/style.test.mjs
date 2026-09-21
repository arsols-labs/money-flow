import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createStyle, styleEnabled } from './style.mjs';

describe('style', () => {
  it('disables color when NO_COLOR is set', () => {
    assert.equal(styleEnabled({ NO_COLOR: '1' }, { isTTY: true }), false);
    const style = createStyle({ enabled: false });
    assert.equal(style.ok('ok'), 'ok');
    assert.equal(style.secret('tok'), 'tok');
  });

  it('colorizes ok / warn / secret when enabled', () => {
    const style = createStyle({ enabled: true });
    assert.match(style.ok('ok'), /\u001b\[32m/);
    assert.match(style.warn('warn'), /\u001b\[33m/);
    assert.match(style.danger('alert'), /\u001b\[31m/);
    assert.match(style.secret('tok'), /\u001b\[35m/);
    assert.match(style.ok('ok'), /ok/);
  });
});
