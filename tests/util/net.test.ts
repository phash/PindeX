import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  isLoopbackHostname,
  hostnameFromHeader,
  loopbackEnforced,
  isAllowedHost,
  isAllowedOrigin,
} from '../../src/util/net.js';

describe('src/util/net', () => {
  let savedBindHost: string | undefined;

  beforeEach(() => {
    savedBindHost = process.env.PINDEX_BIND_HOST;
  });

  afterEach(() => {
    if (savedBindHost === undefined) {
      delete process.env.PINDEX_BIND_HOST;
    } else {
      process.env.PINDEX_BIND_HOST = savedBindHost;
    }
  });

  describe('isLoopbackHostname', () => {
    it('treats localhost / 127.0.0.1 / ::1 as loopback', () => {
      expect(isLoopbackHostname('localhost')).toBe(true);
      expect(isLoopbackHostname('127.0.0.1')).toBe(true);
      expect(isLoopbackHostname('::1')).toBe(true);
    });

    it('is case-insensitive', () => {
      expect(isLoopbackHostname('LOCALHOST')).toBe(true);
      expect(isLoopbackHostname('LocalHost')).toBe(true);
    });

    it('strips surrounding brackets from IPv6 literals', () => {
      expect(isLoopbackHostname('[::1]')).toBe(true);
    });

    it('rejects foreign hostnames and IPs', () => {
      expect(isLoopbackHostname('example.com')).toBe(false);
      expect(isLoopbackHostname('0.0.0.0')).toBe(false);
      expect(isLoopbackHostname('10.0.0.5')).toBe(false);
      expect(isLoopbackHostname('192.168.1.10')).toBe(false);
      expect(isLoopbackHostname('evil.example.com')).toBe(false);
    });
  });

  describe('hostnameFromHeader', () => {
    it('returns empty string for undefined', () => {
      expect(hostnameFromHeader(undefined)).toBe('');
    });

    it('strips a trailing port', () => {
      expect(hostnameFromHeader('localhost:7843')).toBe('localhost');
      expect(hostnameFromHeader('127.0.0.1:8080')).toBe('127.0.0.1');
    });

    it('keeps a hostname without a port unchanged', () => {
      expect(hostnameFromHeader('localhost')).toBe('localhost');
      expect(hostnameFromHeader('example.com')).toBe('example.com');
    });

    it('extracts the inner host from a bracketed IPv6 literal with port', () => {
      expect(hostnameFromHeader('[::1]:7843')).toBe('::1');
    });

    it('extracts the inner host from a bracketed IPv6 literal without port', () => {
      expect(hostnameFromHeader('[::1]')).toBe('::1');
    });
  });

  describe('loopbackEnforced', () => {
    it('is enforced when PINDEX_BIND_HOST is unset', () => {
      delete process.env.PINDEX_BIND_HOST;
      expect(loopbackEnforced()).toBe(true);
    });

    it('is enforced when PINDEX_BIND_HOST is a loopback address', () => {
      process.env.PINDEX_BIND_HOST = '127.0.0.1';
      expect(loopbackEnforced()).toBe(true);
    });

    it('is NOT enforced when PINDEX_BIND_HOST is a non-loopback address', () => {
      process.env.PINDEX_BIND_HOST = '0.0.0.0';
      expect(loopbackEnforced()).toBe(false);
    });
  });

  describe('isAllowedHost', () => {
    describe('with loopback enforcement (PINDEX_BIND_HOST unset)', () => {
      beforeEach(() => {
        delete process.env.PINDEX_BIND_HOST;
      });

      it('allows loopback hosts', () => {
        expect(isAllowedHost('localhost:7843')).toBe(true);
        expect(isAllowedHost('127.0.0.1:7843')).toBe(true);
        expect(isAllowedHost('[::1]:7843')).toBe(true);
      });

      it('rejects foreign hosts (DNS rebinding defense)', () => {
        expect(isAllowedHost('evil.example.com')).toBe(false);
        expect(isAllowedHost('attacker.test:7843')).toBe(false);
      });

      it('rejects an empty / missing Host header', () => {
        expect(isAllowedHost(undefined)).toBe(false);
        expect(isAllowedHost('')).toBe(false);
      });
    });

    describe('with loopback enforcement (PINDEX_BIND_HOST=127.0.0.1)', () => {
      beforeEach(() => {
        process.env.PINDEX_BIND_HOST = '127.0.0.1';
      });

      it('allows loopback hosts', () => {
        expect(isAllowedHost('127.0.0.1:7843')).toBe(true);
      });

      it('rejects foreign hosts', () => {
        expect(isAllowedHost('evil.example.com')).toBe(false);
      });
    });

    describe('without enforcement (PINDEX_BIND_HOST=0.0.0.0)', () => {
      beforeEach(() => {
        process.env.PINDEX_BIND_HOST = '0.0.0.0';
      });

      it('allows any host, including foreign ones', () => {
        expect(isAllowedHost('evil.example.com')).toBe(true);
        expect(isAllowedHost('localhost:7843')).toBe(true);
        expect(isAllowedHost(undefined)).toBe(true);
        expect(isAllowedHost('')).toBe(true);
      });
    });
  });

  describe('isAllowedOrigin', () => {
    it('allows a missing Origin (non-browser clients like CLI/curl)', () => {
      expect(isAllowedOrigin(undefined)).toBe(true);
      expect(isAllowedOrigin('')).toBe(true);
    });

    it('allows loopback origins', () => {
      expect(isAllowedOrigin('http://localhost:7843')).toBe(true);
      expect(isAllowedOrigin('http://127.0.0.1:7843')).toBe(true);
      expect(isAllowedOrigin('http://[::1]:7843')).toBe(true);
    });

    it('rejects foreign origins (CSWSH / CSRF defense)', () => {
      expect(isAllowedOrigin('http://evil.example.com')).toBe(false);
      expect(isAllowedOrigin('https://attacker.test')).toBe(false);
    });

    it('rejects an unparseable origin', () => {
      expect(isAllowedOrigin('not a url')).toBe(false);
      expect(isAllowedOrigin('::::')).toBe(false);
    });
  });
});
