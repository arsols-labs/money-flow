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
  RATE_LIMIT_OAUTH_REGISTER?: RateLimit;
  RATE_LIMIT_AUTH_SETUP?: RateLimit;
  RATE_LIMIT_AUTH_LOGIN?: RateLimit;
  RATE_LIMIT_MCP_DISPATCH?: RateLimit;
}

