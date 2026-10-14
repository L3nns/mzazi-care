/**
 * Storage for provider media (PROVIDER_MEDIA in Figure 4.8): profile images,
 * shown publicly, and the supporting evidence an administrator reviews before
 * verifying a listing (Figure 4.14), which is never public.
 *
 * Files live under UPLOAD_DIR with random names; the database keeps only the
 * file name. The type is decided from the file's first bytes, not from what
 * the browser claims, so a renamed script cannot be stored as an "image".
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR
  || path.join(__dirname, '..', 'uploads'));
const MAX_BYTES = Number(process.env.UPLOAD_MAX_BYTES || 5 * 1024 * 1024);

const SIGNATURES = [
  { ext: 'pdf', mime: 'application/pdf', magic: Buffer.from('%PDF-') },
  { ext: 'png', mime: 'image/png', magic: Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
  { ext: 'jpg', mime: 'image/jpeg', magic: Buffer.from([0xff, 0xd8, 0xff]) },
];
const MIME = Object.fromEntries(SIGNATURES.map((s) => [s.ext, s.mime]));

/** The detected type of a buffer, or null if it is not an accepted file. */
function sniff(buf) {
  if (!Buffer.isBuffer(buf)) return null;
  return SIGNATURES.find((s) => buf.subarray(0, s.magic.length).equals(s.magic)) || null;
}

/** Writes the buffer and returns the stored file name. */
function store(providerId, buf, kind) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  const type = sniff(buf);
  const name = `p${Number(providerId)}-${kind}-${crypto.randomBytes(8).toString('hex')}.${type.ext}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, name), buf, { flag: 'wx' });
  return name;
}

/** Absolute path for a stored name, refusing anything outside UPLOAD_DIR. */
function resolve(fileName) {
  const base = path.basename(String(fileName || ''));
  if (!base || base !== fileName) return null;
  return path.join(UPLOAD_DIR, base);
}

function remove(fileName) {
  const file = resolve(fileName);
  if (file) fs.rm(file, { force: true }, () => {});
}

const mimeFor = (fileName) => MIME[path.extname(String(fileName)).slice(1)] || 'application/octet-stream';

module.exports = {
  UPLOAD_DIR, MAX_BYTES, ACCEPTED: SIGNATURES.map((s) => s.mime),
  sniff, store, resolve, remove, mimeFor,
};
