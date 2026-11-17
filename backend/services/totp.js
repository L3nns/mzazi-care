/**
 * Time-based one-time passwords (RFC 6238) for two-step sign-in, plus
 * encryption of the shared secret at rest. Built on Node's crypto module; the
 * algorithm is small enough that a dependency would add more risk than code.
 *
 * Works with any authenticator app (Google Authenticator, Microsoft
 * Authenticator, Aegis, 1Password): SHA-1, 6 digits, 30-second steps.
 */
const crypto = require('crypto');

const STEP_SECONDS = 30;
const DIGITS = 6;
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buf) {
  let bits = 0; let value = 0; let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(str) {
  const clean = String(str).toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0; let value = 0; const out = [];
  for (const ch of clean) {
    const idx = ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error('invalid base32 character');
    value = (value << 5) | idx; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

/** HOTP (RFC 4226) for one counter value. */
function hotp(key, counter, digits = DIGITS) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = crypto.createHmac('sha1', key).update(msg).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const code = (mac.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits;
  return String(code).padStart(digits, '0');
}

const stepAt = (ms = Date.now()) => Math.floor(ms / 1000 / STEP_SECONDS);

/**
 * Checks a code against the current step and one step either side (clock
 * drift). Returns the matching step, so the caller can refuse to accept the
 * same step twice, or null.
 */
function verify(secretBase32, code, { now = Date.now(), window = 1 } = {}) {
  if (!/^\d{6}$/.test(String(code || ''))) return null;
  const key = base32Decode(secretBase32);
  const current = stepAt(now);
  for (let d = -window; d <= window; d += 1) {
    const candidate = hotp(key, current + d);
    if (crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(String(code)))) return current + d;
  }
  return null;
}

const generateSecret = () => base32Encode(crypto.randomBytes(20));

/** The otpauth:// link authenticator apps read (typed in, or as a QR code). */
const otpauthUri = (secret, account, issuer = 'Mzazi Care') =>
  `otpauth://totp/${encodeURIComponent(`${issuer}:${account}`)}?secret=${secret}`
  + `&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP_SECONDS}`;

/* ------------------------------------------------- secret at rest (AES-GCM) */
function keyFrom(material) {
  return crypto.createHash('sha256').update(`mzazi-mfa:${material}`).digest();
}

function encrypt(plain, material) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyFrom(material), iv);
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'),
    body.toString('base64')].join(':');
}

function decrypt(stored, material) {
  const [v, iv, tag, body] = String(stored).split(':');
  if (v !== 'v1') throw new Error('unknown secret format');
  const decipher = crypto.createDecipheriv('aes-256-gcm', keyFrom(material), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(body, 'base64')), decipher.final()]).toString('utf8');
}

module.exports = {
  base32Encode, base32Decode, hotp, verify, stepAt, generateSecret, otpauthUri, encrypt, decrypt,
};
