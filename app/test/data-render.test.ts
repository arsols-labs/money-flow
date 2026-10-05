import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, it, expect } from 'vitest';
import { RefreshProvider } from '../src/ui/RefreshContext.jsx';
import Data from '../src/ui/Data.jsx';

// Regression for #397: the "Data" screen was completely empty because
// Data.jsx called useRefreshNonce() (added as part of #381) without importing it from
// ./RefreshContext. That is a ReferenceError at render time, and without an ErrorBoundary
// the whole "Data" page rendered empty. tsc does NOT catch this (verified:
// npm run check is green on the broken code), so we catch it with a runtime render.
//
// useRefreshNonce() is called unconditionally in the body of Data(), so a static
// server render (renderToStaticMarkup) executes it and throws on broken
// code, and on the fixed code successfully returns "Loading data…" (before effects).
describe('Data screen renders without throwing', () => {
  it('does not throw on initial render (useRefreshNonce imported)', () => {
    expect(() =>
      renderToStaticMarkup(
        React.createElement(RefreshProvider, null, React.createElement(Data)),
      ),
    ).not.toThrow();
  });
});
