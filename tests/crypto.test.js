const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { createCipher } = require('../src/lib/crypto');

const k1 = crypto.randomBytes(32).toString('base64');
const k2 = crypto.randomBytes(32).toString('base64');

test('encrypt/decrypt roundtrip', () => {
  const c = createCipher({ keys: `k1:${k1}`, activeKey: 'k1' });
  const enc = c.encrypt('+919876543210');
  assert.notStrictEqual(enc, '+919876543210');
  assert.ok(enc.startsWith('k1.'));
  assert.strictEqual(c.decrypt(enc), '+919876543210');
});

test('same plaintext gives different ciphertext (random iv)', () => {
  const c = createCipher({ keys: `k1:${k1}`, activeKey: 'k1' });
  assert.notStrictEqual(c.encrypt('abc'), c.encrypt('abc'));
});

test('old rows still decrypt after key rotation', () => {
  const before = createCipher({ keys: `k1:${k1}`, activeKey: 'k1' });
  const oldValue = before.encrypt('fever, 3 days');

  const after = createCipher({ keys: `k1:${k1},k2:${k2}`, activeKey: 'k2' });
  assert.strictEqual(after.decrypt(oldValue), 'fever, 3 days');
  assert.ok(after.needsRotation(oldValue));
  assert.ok(after.encrypt('x').startsWith('k2.'));
});

test('tampered ciphertext is rejected', () => {
  const c = createCipher({ keys: `k1:${k1}`, activeKey: 'k1' });
  const parts = c.encrypt('secret').split('.');
  parts[3] = Buffer.from('tampered').toString('base64url');
  assert.throws(() => c.decrypt(parts.join('.')));
});

test('null passes through', () => {
  const c = createCipher({ keys: `k1:${k1}`, activeKey: 'k1' });
  assert.strictEqual(c.encrypt(null), null);
  assert.strictEqual(c.decrypt(null), null);
});
