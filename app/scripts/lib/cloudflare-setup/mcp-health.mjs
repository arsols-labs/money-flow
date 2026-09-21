const SETUP_UA = 'money-flow-setup';

/**
 * Required post-deploy check: MCP HTTP endpoint + OAuth discovery.
 * Does not run an MCP session or chatbot E2E. Never throws; timeouts
 * and fetch failures return `{ ok: false }` so setup can warn and exit 0.
 *
 * Unauthenticated HTTP 401 on `/mcp` is expected (OAuth-protected) and
 * counts as ready when OAuth discovery is up.
 * @param {string} appOrigin
 * @param {{
 *   fetchImpl?: typeof fetch,
 *   timeoutMs?: number,
 * }} [options]
 */
export async function probeMcpHealth(appOrigin, options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 8000;
  const origin = String(appOrigin || '').replace(/\/$/, '');
  const mcpUrl = `${origin}/mcp`;
  const oauthUrl = `${origin}/.well-known/oauth-authorization-server`;

  try {
    const [mcp, oauth] = await Promise.all([
      getJson(fetchImpl, mcpUrl, timeoutMs),
      getJson(fetchImpl, oauthUrl, timeoutMs),
    ]);
    return summarizeProbe({ mcpUrl, oauthUrl, mcp, oauth });
  } catch (error) {
    const message = String(error?.message || error);
    return {
      ok: false,
      ready: false,
      mcpExpectedUnauth: false,
      mcp: { url: mcpUrl, ok: false, status: 0, error: message },
      oauth: { url: oauthUrl, ok: false, status: 0, error: message },
    };
  }
}

/**
 * Poll until the Worker answers (OAuth discovery + MCP ready or expected 401)
 * or the wait budget is spent. Soft-fails; never hangs past waitTimeoutMs.
 * @param {string} appOrigin
 * @param {{
 *   fetchImpl?: typeof fetch,
 *   timeoutMs?: number,
 *   waitTimeoutMs?: number,
 *   intervalMs?: number,
 *   sleep?: (ms: number) => Promise<void>,
 *   onWait?: () => void,
 * }} [options]
 */
export async function waitForMcpHealth(appOrigin, options = {}) {
  const waitTimeoutMs = options.waitTimeoutMs ?? 45_000;
  const intervalMs = options.intervalMs ?? 2000;
  const sleep = options.sleep ?? defaultSleep;
  const started = Date.now();
  let announcedWait = false;
  let last = await probeMcpHealth(appOrigin, options);

  while (!last.ok && Date.now() - started < waitTimeoutMs) {
    if (!announcedWait) {
      announcedWait = true;
      options.onWait?.();
    }
    await sleep(intervalMs);
    last = await probeMcpHealth(appOrigin, options);
  }

  return { ...last, waited: announcedWait };
}

export function mcpProbeIsExpectedUnauth(status) {
  return status === 401;
}

function summarizeProbe({ mcpUrl, oauthUrl, mcp, oauth }) {
  const oauthOk =
    oauth.status === 200 && Boolean(oauth.body?.issuer || oauth.body?.authorization_endpoint);
  const mcpHealthOk = mcp.status >= 200 && mcp.status < 400 && mcp.body?.status === 'ok';
  const mcpExpectedUnauth = mcpProbeIsExpectedUnauth(mcp.status);
  const mcpReady = mcpHealthOk || mcpExpectedUnauth;
  const ok = oauthOk && mcpReady;

  return {
    ok,
    ready: ok,
    mcpExpectedUnauth,
    mcp: {
      url: mcpUrl,
      ok: mcpReady,
      status: mcp.status,
      error: mcpReady ? null : mcp.error,
    },
    oauth: { url: oauthUrl, ok: oauthOk, status: oauth.status, error: oauth.error },
  };
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout(promise, timeoutMs, onTimeout) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      onTimeout?.();
      const error = new Error(`timed out after ${timeoutMs}ms`);
      error.name = 'AbortError';
      reject(error);
    }, timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function getJson(fetchImpl, url, timeoutMs) {
  const controller = new AbortController();
  try {
    const response = await withTimeout(
      Promise.resolve().then(() =>
        fetchImpl(url, {
          method: 'GET',
          headers: { accept: 'application/json', 'user-agent': SETUP_UA },
          signal: controller.signal,
          redirect: 'follow',
        }),
      ),
      timeoutMs,
      () => {
        try {
          controller.abort();
        } catch {
          // AbortController.abort is not expected to throw.
        }
      },
    );
    let body = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    return { status: response.status, body, error: null };
  } catch (error) {
    const message = error?.name === 'AbortError' ? `timed out after ${timeoutMs}ms` : String(error?.message || error);
    return { status: 0, body: null, error: message };
  }
}
