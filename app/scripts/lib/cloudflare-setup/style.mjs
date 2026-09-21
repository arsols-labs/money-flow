const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const CYAN = '\x1b[36m';
const MAGENTA = '\x1b[35m';

export function styleEnabled(env = process.env, stream) {
  if (env?.NO_COLOR) return false;
  if (env?.FORCE_COLOR && env.FORCE_COLOR !== '0') return true;
  return Boolean(stream?.isTTY);
}

function wrap(enabled, code, text) {
  return enabled ? `${code}${text}${RESET}` : text;
}

/**
 * @param {{ enabled?: boolean }} [options]
 */
export function createStyle(options = {}) {
  const enabled = options.enabled === true;
  return {
    enabled,
    ok: (text) => wrap(enabled, GREEN, text),
    warn: (text) => wrap(enabled, YELLOW, text),
    danger: (text) => wrap(enabled, `${BOLD}${RED}`, text),
    secret: (text) => wrap(enabled, `${BOLD}${MAGENTA}`, text),
    info: (text) => wrap(enabled, CYAN, text),
    dim: (text) => wrap(enabled, DIM, text),
    heading: (text) => wrap(enabled, BOLD, text),
  };
}
