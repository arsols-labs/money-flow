import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, it, expect } from 'vitest';
import { RefreshProvider } from '../src/ui/RefreshContext.jsx';
import Data from '../src/ui/Data.jsx';

// Регрессия на #397: экран «Данные» был полностью пустым, потому что
// Data.jsx вызывал useRefreshNonce() (добавлено в рамках #381) без импорта из
// ./RefreshContext. Это ReferenceError в момент рендера, и без ErrorBoundary
// вся страница «Данные» рендерилась пустой. tsc этого НЕ ловит (проверено:
// npm run check зелёный на сломанном коде), поэтому ловим рантайм-рендером.
//
// useRefreshNonce() вызывается в теле Data() безусловно, поэтому статический
// серверный рендер (renderToStaticMarkup) исполняет его и падает на сломанном
// коде, а на исправленном — успешно отдаёт «Загружаю данные…» (до эффектов).
describe('Data screen renders without throwing', () => {
  it('does not throw on initial render (useRefreshNonce imported)', () => {
    expect(() =>
      renderToStaticMarkup(
        React.createElement(RefreshProvider, null, React.createElement(Data)),
      ),
    ).not.toThrow();
  });
});
