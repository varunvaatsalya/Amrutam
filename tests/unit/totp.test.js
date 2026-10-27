const test = require('node:test');
const assert = require('node:assert');
const totp = require('../../src/lib/totp');

// RFC 6238 appendix B, SHA1, secret "12345678901234567890" (last 6 digits)
const RFC_SECRET = totp.base32Encode(Buffer.from('12345678901234567890'));

test('matches RFC 6238 test vectors', () => {
  assert.strictEqual(RFC_SECRET, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  assert.strictEqual(totp.generate(RFC_SECRET, 59_000), '287082');
  assert.strictEqual(totp.generate(RFC_SECRET, 1111111109_000), '081804');
  assert.strictEqual(totp.generate(RFC_SECRET, 2000000000_000), '279037');
});

test('accepts one step of clock drift, not more', () => {
  const s = totp.generateSecret();
  const now = Date.now();
  assert.ok(totp.verify(s, totp.generate(s, now - 30_000), now));
  assert.ok(totp.verify(s, totp.generate(s, now + 30_000), now));
  assert.ok(!totp.verify(s, totp.generate(s, now - 90_000), now));
});

test('rejects malformed codes', () => {
  const s = totp.generateSecret();
  assert.ok(!totp.verify(s, '12345'));
  assert.ok(!totp.verify(s, 'abcdef'));
});
