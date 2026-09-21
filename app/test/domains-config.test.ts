import { describe, expect, it } from 'vitest';
import app from '../src/worker/index';
import { isAllowedHost, isAllowedOrigin, resolveOrigin, resolveRpID } from '../src/worker/auth';
import type { Env } from '../src/worker/types';

describe('Domains & Environment Configuration (De-personalization, #509)', () => {
  const dummyEnv: Env = {
    KV: {} as any,
    OAUTH_KV: {} as any,
    DB: {} as any,
    ASSETS: {} as any,
    SESSION_SECRET: 'test-session-secret-for-testing-only-min-32-chars',
    SETUP_TOKEN: 'test-setup-token',
    APP_DOMAIN: 'app.example.com',
  };

  describe('isAllowedHost & Host Security (Anti-Spoofing)', () => {
    it('разрешает канонический прод-домен и edge-хост', () => {
      expect(isAllowedHost('app.example.com', 'app.example.com', 'app.example.com')).toBe(true);
      expect(isAllowedHost('app.example.com', 'any-edge.com', 'app.example.com')).toBe(true);
    });

    it('разрешает канонические staging и dev preview-домены Cloudflare', () => {
      expect(
        isAllowedHost(
          'staging-money-flow.workers.dev',
          'staging-money-flow.workers.dev',
          'app.example.com',
        ),
      ).toBe(true);
      expect(
        isAllowedHost(
          'dev-money-flow.workers.dev',
          'dev-money-flow.workers.dev',
          'app.example.com',
        ),
      ).toBe(true);
    });

    it('разрешает localhost и 127.0.0.1 для локальной разработки', () => {
      expect(isAllowedHost('localhost', 'localhost', 'app.example.com')).toBe(true);
      expect(isAllowedHost('127.0.0.1', '127.0.0.1', 'app.example.com')).toBe(true);
    });

    it('БЛОКИРУЕТ попытки подделки хоста (evil.com, attacker.com)', () => {
      expect(isAllowedHost('evil.com', 'app.example.com', 'app.example.com')).toBe(false);
      expect(isAllowedHost('attacker.com', 'localhost', 'app.example.com')).toBe(false);
      expect(isAllowedHost('not-real-subdomain.com', 'staging-money-flow.workers.dev')).toBe(
        false,
      );
    });

    it('не считает весь *.workers.dev доверенным (#533)', () => {
      expect(
        isAllowedHost('evil.workers.dev', 'app.example.com', 'app.example.com'),
      ).toBe(false);
      expect(
        isAllowedHost(
          'preview-money-flow.workers.dev',
          'app.example.com',
          'app.example.com',
        ),
      ).toBe(false);
      // Public cut: empty preview allowlist. A workers.dev host is trusted
      // only when it is the request edge host (asserted below).
      expect(
        isAllowedHost(
          'staging-money-flow.workers.dev',
          'app.example.com',
          'app.example.com',
        ),
      ).toBe(false);
      expect(
        isAllowedHost(
          'preview-money-flow.workers.dev',
          'preview-money-flow.workers.dev',
          'app.example.com',
        ),
      ).toBe(true);
    });
  });

  describe('resolveRpID & resolveOrigin для 4 сред', () => {
    it('1. Production: корректно определяет прод-домен', () => {
      const c = {
        req: {
          url: 'https://app.example.com/api/auth/login/options',
          header: (name: string) => (name === 'host' ? 'app.example.com' : undefined),
        },
        env: dummyEnv,
      };
      expect(resolveRpID(c)).toBe('app.example.com');
      expect(resolveOrigin(c)).toBe('https://app.example.com');
    });

    it('2. Staging: корректно определяет staging preview origin и RP ID', () => {
      const c = {
        req: {
          url: 'https://staging-money-flow.workers.dev/api/auth/login/options',
          header: (name: string) =>
            name === 'origin'
              ? 'https://staging-money-flow.workers.dev'
              : name === 'host'
                ? 'staging-money-flow.workers.dev'
                : undefined,
        },
        env: {
          ...dummyEnv,
          APP_DOMAIN: 'staging-money-flow.workers.dev',
        },
      };
      expect(resolveRpID(c)).toBe('staging-money-flow.workers.dev');
      expect(resolveOrigin(c)).toBe('https://staging-money-flow.workers.dev');
    });

    it('3. Dev: корректно определяет dev preview origin и RP ID', () => {
      const c = {
        req: {
          url: 'https://dev-money-flow.workers.dev/api/auth/login/options',
          header: (name: string) =>
            name === 'origin'
              ? 'https://dev-money-flow.workers.dev'
              : name === 'host'
                ? 'dev-money-flow.workers.dev'
                : undefined,
        },
        env: {
          ...dummyEnv,
          APP_DOMAIN: 'dev-money-flow.workers.dev',
        },
      };
      expect(resolveRpID(c)).toBe('dev-money-flow.workers.dev');
      expect(resolveOrigin(c)).toBe('https://dev-money-flow.workers.dev');
    });

    it('4. Localhost: разрешает порт и выделяет чистый RP ID без порта', () => {
      const c = {
        req: {
          url: 'http://localhost:8787/api/auth/login/options',
          header: (name: string) =>
            name === 'origin'
              ? 'http://localhost:8787'
              : name === 'host'
                ? 'localhost:8787'
                : undefined,
        },
        env: {
          ...dummyEnv,
          APP_DOMAIN: 'localhost:8787',
        },
      };
      expect(resolveRpID(c)).toBe('localhost');
      expect(resolveOrigin(c)).toBe('http://localhost:8787');
    });

    it('Защита от подделки: при попытке передать Origin: https://evil.com отбрасывает его и использует edge-хост', () => {
      const c = {
        req: {
          url: 'https://app.example.com/api/auth/login/options',
          header: (name: string) => (name === 'origin' ? 'https://evil.com' : undefined),
        },
        env: dummyEnv,
      };
      expect(resolveRpID(c)).toBe('app.example.com');
      expect(resolveOrigin(c)).toBe('https://app.example.com');
    });
  });

  describe('CORS Whitelist & Preflight', () => {
    it('разрешает доверенные домены и возвращает Access-Control-Allow-Origin', async () => {
      const res = await app.request(
        'http://localhost:8787/api/auth/me',
        {
          method: 'OPTIONS',
          headers: {
            Origin: 'http://localhost:8787',
            'Access-Control-Request-Method': 'GET',
          },
        },
        dummyEnv,
      );
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:8787');
      expect(res.headers.get('Access-Control-Allow-Credentials')).toBe('true');
    });

    it('БЛОКИРУЕТ недоверенный origin (Access-Control-Allow-Origin не выставляется)', async () => {
      const res = await app.request(
        'https://app.example.com/api/auth/me',
        {
          method: 'OPTIONS',
          headers: {
            Origin: 'https://evil-attacker.com',
            'Access-Control-Request-Method': 'GET',
          },
        },
        dummyEnv,
      );
      expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
    });
  });
});
