import type { OAuthHelpers } from '@cloudflare/workers-oauth-provider';

export interface Env {
  KV: KVNamespace;
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER?: OAuthHelpers;
  DB: D1Database;
  ASSETS: Fetcher;
  SESSION_SECRET: string;
  SETUP_TOKEN: string;
  APP_DOMAIN?: string;
  AUTH_USER_NAME?: string;
  /** `"1"` selects session-isolated demo ledgers. Unset on self-hosted installs. */
  DEMO_MODE?: string;
  /**
   * SQLite Durable Object namespace for demo sessions.
   * Required when DEMO_MODE=1. Unused otherwise.
   */
  DEMO_SESSION?: DurableObjectNamespace;
  RATE_LIMIT_OAUTH_REGISTER?: RateLimit;
  RATE_LIMIT_AUTH_SETUP?: RateLimit;
  RATE_LIMIT_AUTH_LOGIN?: RateLimit;
  RATE_LIMIT_MCP_DISPATCH?: RateLimit;
  RATE_LIMIT_DEMO_SESSION?: RateLimit;
}

