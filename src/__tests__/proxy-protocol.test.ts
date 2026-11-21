import { describe, it, expect } from 'vitest';
import {
  tryParseProxyHeader,
  parseProxyHeaderFromChunks,
  ProxyProtocolError,
} from '../util/proxyProtocol';
import { isTrustedProxyPeer, parseTrustedProxies } from '../util/ip';

describe('PROXY protocol parser', () => {
  describe('v1 full header', () => {
    it('parses TCP4 source IP and port', () => {
      const header = Buffer.from('PROXY TCP4 203.0.113.10 10.0.0.1 50123 8082\r\n', 'ascii');
      const app = Buffer.from([0x01, 0x02, 0x03]);
      const result = tryParseProxyHeader(Buffer.concat([header, app]));

      expect(result).toMatchObject({
        present: true,
        version: 1,
        clientIp: '203.0.113.10',
        clientPort: 50123,
      });
      if (!('incomplete' in result)) {
        expect(result.leftover.equals(app)).toBe(true);
      }
    });

    it('parses TCP6 source IP', () => {
      const header = Buffer.from(
        'PROXY TCP6 2001:db8::1 2001:db8::2 12345 8082\r\n',
        'ascii'
      );
      const result = tryParseProxyHeader(header);
      expect(result).toMatchObject({
        present: true,
        version: 1,
        clientIp: '2001:db8::1',
        clientPort: 12345,
      });
    });

    it('handles PROXY UNKNOWN', () => {
      const header = Buffer.from('PROXY UNKNOWN\r\n', 'ascii');
      const result = tryParseProxyHeader(header);
      expect(result).toMatchObject({ present: true, version: 1 });
      if (!('incomplete' in result)) {
        expect(result.clientIp).toBeUndefined();
        expect(result.leftover.length).toBe(0);
      }
    });
  });

  describe('split chunks', () => {
    it('returns incomplete until CRLF arrives', () => {
      const part1 = Buffer.from('PROXY TCP4 203.0.113.10 ', 'ascii');
      const part2 = Buffer.from('10.0.0.1 50123 8082\r\n\x01', 'ascii');

      expect(tryParseProxyHeader(part1)).toEqual({ incomplete: true });

      const result = parseProxyHeaderFromChunks([part1, part2]);
      expect(result).toMatchObject({
        present: true,
        clientIp: '203.0.113.10',
        clientPort: 50123,
      });
      if (!('incomplete' in result)) {
        expect(result.leftover.equals(Buffer.from([0x01]))).toBe(true);
      }
    });

    it('handles v1 prefix split one byte at a time', () => {
      const header = Buffer.from('PROXY TCP4 1.2.3.4 5.6.7.8 9 10\r\n', 'ascii');
      const chunks = [...header].map((b) => Buffer.from([b]));
      // App data arrives in the same final parse window as CRLF
      chunks[chunks.length - 1] = Buffer.from([header[header.length - 1], 0x41, 0x42]);
      const result = parseProxyHeaderFromChunks(chunks);
      expect(result).toMatchObject({ present: true, clientIp: '1.2.3.4' });
      if (!('incomplete' in result)) {
        expect(result.leftover.toString('ascii')).toBe('AB');
      }
    });
  });

  describe('absent header', () => {
    it('treats device opcode bytes as application data', () => {
      // Typical login opcode 0x01 + address bytes
      const app = Buffer.from([0x01, 0xaa, 0xbb, 0xcc]);
      const result = tryParseProxyHeader(app);
      expect(result).toMatchObject({ present: false });
      if (!('incomplete' in result)) {
        expect(result.leftover.equals(app)).toBe(true);
      }
    });

    it('treats empty buffer as incomplete', () => {
      expect(tryParseProxyHeader(Buffer.alloc(0))).toEqual({ incomplete: true });
    });
  });

  describe('malformed', () => {
    it('throws when v1 exceeds max length without CRLF', () => {
      const huge = Buffer.concat([
        Buffer.from('PROXY TCP4 ', 'ascii'),
        Buffer.alloc(120, 0x41),
      ]);
      expect(() => tryParseProxyHeader(huge)).toThrow(ProxyProtocolError);
    });

    it('throws on short v1 field list', () => {
      const bad = Buffer.from('PROXY TCP4 1.2.3.4\r\n', 'ascii');
      expect(() => tryParseProxyHeader(bad)).toThrow(ProxyProtocolError);
    });
  });

  describe('v2 binary', () => {
    it('parses IPv4 stream header', () => {
      // sig(12) + ver_cmd(1) + family(1) + len(2) + src(4)+dst(4)+sport(2)+dport(2)
      const buf = Buffer.alloc(16 + 12);
      Buffer.from([
        0x0d, 0x0a, 0x0d, 0x0a, 0x00, 0x0d, 0x0a, 0x51, 0x55, 0x49, 0x54, 0x0a,
      ]).copy(buf, 0);
      buf[12] = 0x21; // version 2, PROXY cmd
      buf[13] = 0x11; // AF_INET << 4 | STREAM
      buf.writeUInt16BE(12, 14);
      buf[16] = 198;
      buf[17] = 51;
      buf[18] = 100;
      buf[19] = 20;
      buf[20] = 10;
      buf[21] = 0;
      buf[22] = 0;
      buf[23] = 1;
      buf.writeUInt16BE(44321, 24);
      buf.writeUInt16BE(8082, 26);

      const app = Buffer.from([0x06]);
      const result = tryParseProxyHeader(Buffer.concat([buf, app]));
      expect(result).toMatchObject({
        present: true,
        version: 2,
        clientIp: '198.51.100.20',
        clientPort: 44321,
      });
      if (!('incomplete' in result)) {
        expect(result.leftover.equals(app)).toBe(true);
      }
    });

    it('returns incomplete for partial v2', () => {
      const partial = Buffer.from([
        0x0d, 0x0a, 0x0d, 0x0a, 0x00, 0x0d, 0x0a, 0x51, 0x55, 0x49, 0x54, 0x0a,
        0x21, 0x11,
      ]);
      expect(tryParseProxyHeader(partial)).toEqual({ incomplete: true });
    });
  });

  describe('untrusted peer policy helpers', () => {
    it('defaults trusted list to loopback', () => {
      expect(parseTrustedProxies(undefined)).toEqual(['127.0.0.1', '::1']);
      expect(isTrustedProxyPeer('127.0.0.1')).toBe(true);
      expect(isTrustedProxyPeer('::1')).toBe(true);
      expect(isTrustedProxyPeer('::ffff:127.0.0.1')).toBe(true);
      expect(isTrustedProxyPeer('203.0.113.1')).toBe(false);
    });

    it('honors custom trusted list', () => {
      const trusted = parseTrustedProxies('10.0.0.5, 192.168.1.1');
      expect(isTrustedProxyPeer('10.0.0.5', trusted)).toBe(true);
      expect(isTrustedProxyPeer('127.0.0.1', trusted)).toBe(false);
    });
  });
});
