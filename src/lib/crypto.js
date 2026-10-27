const crypto = require('crypto');

// Field level encryption for PHI/PII columns (AES-256-GCM).
// Stored format: <keyId>.<iv>.<authTag>.<ciphertext>  (all base64url)
// keyId lets us rotate keys without a big-bang migration - old rows decrypt
// with the old key, new writes use the active key.
function createCipher({ keys, activeKey }) {
  const keyMap = new Map();
  for (const pair of keys.split(',')) {
    const [id, b64] = pair.trim().split(':');
    const buf = Buffer.from(b64 || '', 'base64');
    if (buf.length !== 32) throw new Error(`encryption key ${id} must be 32 bytes`);
    keyMap.set(id, buf);
  }
  if (!keyMap.has(activeKey)) throw new Error(`active key ${activeKey} not in ENCRYPTION_KEYS`);

  function encrypt(plain) {
    if (plain === null || plain === undefined) return null;
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', keyMap.get(activeKey), iv);
    const enc = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
    return [activeKey, iv.toString('base64url'), c.getAuthTag().toString('base64url'), enc.toString('base64url')].join('.');
  }

  function decrypt(payload) {
    if (!payload) return null;
    const [keyId, iv, tag, data] = payload.split('.');
    const key = keyMap.get(keyId);
    if (!key) throw new Error(`unknown encryption key ${keyId}`);
    const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
    d.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([d.update(Buffer.from(data, 'base64url')), d.final()]).toString('utf8');
  }

  const needsRotation = (payload) => !!payload && !payload.startsWith(`${activeKey}.`);

  return { encrypt, decrypt, needsRotation };
}

const sha256 = (v) => crypto.createHash('sha256').update(v).digest('hex');
const randomToken = (bytes = 48) => crypto.randomBytes(bytes).toString('base64url');

module.exports = { createCipher, sha256, randomToken };
