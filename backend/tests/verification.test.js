/**
 * Unit tests for the verification workflow and TOTP. No app, no database.
 * Run:  npm test
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const v = require('../services/verification');
const totp = require('../services/totp');

test('a decision on a pending listing opens the review first', () => {
  assert.deepEqual(v.plan('pending', 'verified'), ['under_review', 'verified']);
  assert.deepEqual(v.plan('pending', 'rejected'), ['under_review', 'rejected']);
  assert.deepEqual(v.plan('needs_more_information', 'verified'), ['under_review', 'verified']);
  assert.deepEqual(v.plan('under_review', 'needs_more_information'), ['needs_more_information']);
  // Reinstating an expired or suspended listing is a fresh review, recorded as such.
  assert.deepEqual(v.plan('expired', 'verified'), ['under_review', 'verified']);
  assert.deepEqual(v.plan('suspended', 'verified'), ['under_review', 'verified']);
});

test('moves outside the workflow are refused', () => {
  assert.equal(v.plan('verified', 'pending'), null);
  assert.equal(v.plan('rejected', 'verified'), null, 'a rejected listing is resubmitted first');
  assert.equal(v.plan('draft', 'verified'), null);
  assert.equal(v.plan('verified', 'verified'), null);
  assert.equal(v.plan('verified', 'approved'), null);
});

test('every state can be left, and verified is reachable from every queue state', () => {
  for (const s of v.STATES) assert.ok(v.nextStates(s).length, `${s} is a dead end`);
  for (const s of ['pending', 'under_review', 'needs_more_information']) {
    assert.ok(v.nextStates(s).includes('verified'), s);
  }
});

test('document requirements come from the category, then its parent, then the default', () => {
  const cats = new Map([
    [1, { required_documents: 'identity,business_registration', parent_category_id: null }],
    [2, { required_documents: null, parent_category_id: 1 }],
    [3, { required_documents: 'qualification', parent_category_id: 1 }],
    [4, { required_documents: null, parent_category_id: null }],
  ]);
  assert.deepEqual(v.requiredFor(3, cats), ['qualification']);
  assert.deepEqual(v.requiredFor(2, cats), ['identity', 'business_registration']);
  assert.deepEqual(v.requiredFor(4, cats), ['identity']);
  assert.deepEqual(v.requiredFor(99, cats), ['identity']);
});

test('only accepted, current documents satisfy a requirement', () => {
  const today = '2026-06-01';
  const docs = [
    { document_type: 'identity', review_status: 'accepted', expires_on: null },
    { document_type: 'qualification', review_status: 'pending', expires_on: null },
    { document_type: 'professional_registration', review_status: 'accepted', expires_on: '2026-05-31' },
  ];
  assert.deepEqual(
    v.missingDocuments(['identity', 'qualification', 'professional_registration'], docs, today),
    ['qualification', 'professional_registration'],
  );
  // Expiring today is still valid today.
  assert.ok(v.isValid({ review_status: 'accepted', expires_on: '2026-06-01' }, today));
});

test('a lapse is an accepted document that expired, not one never supplied', () => {
  const today = '2026-06-01';
  const docs = [
    { document_type: 'qualification', review_status: 'accepted', expires_on: '2026-01-01' },
  ];
  assert.deepEqual(v.lapsedDocuments(['identity', 'qualification'], docs, today), ['qualification']);
  const renewed = [...docs,
    { document_type: 'qualification', review_status: 'accepted', expires_on: '2027-01-01' }];
  assert.deepEqual(v.lapsedDocuments(['qualification'], renewed, today), []);
});

/* ------------------------------------------------------------------ TOTP */
test('TOTP matches the RFC 6238 SHA-1 test vectors', () => {
  const key = Buffer.from('12345678901234567890');
  // [unix seconds, expected 8-digit code] from RFC 6238 Appendix B.
  const vectors = [[59, '94287082'], [1111111109, '07081804'], [1111111111, '14050471'],
    [1234567890, '89005924'], [2000000000, '69279037'], [20000000000, '65353130']];
  for (const [t, code] of vectors) {
    assert.equal(totp.hotp(key, Math.floor(t / 30), 8), code, `t=${t}`);
  }
});

test('TOTP accepts one step of clock drift and rejects anything else', () => {
  const secret = totp.generateSecret();
  const key = totp.base32Decode(secret);
  const now = 1_800_000_000_000;
  const step = totp.stepAt(now);
  assert.equal(totp.verify(secret, totp.hotp(key, step), { now }), step);
  assert.equal(totp.verify(secret, totp.hotp(key, step - 1), { now }), step - 1);
  assert.equal(totp.verify(secret, totp.hotp(key, step + 2), { now }), null);
  assert.equal(totp.verify(secret, 'abcdef', { now }), null);
  assert.equal(totp.verify(secret, '12345', { now }), null);
});

test('base32 round-trips, and secrets encrypt with authentication', () => {
  const raw = Buffer.from('any bytes at all \x00\xff');
  assert.deepEqual(totp.base32Decode(totp.base32Encode(raw)), raw);
  const sealed = totp.encrypt('JBSWY3DPEHPK3PXP', 'key-material');
  assert.notEqual(sealed, 'JBSWY3DPEHPK3PXP');
  assert.equal(totp.decrypt(sealed, 'key-material'), 'JBSWY3DPEHPK3PXP');
  assert.throws(() => totp.decrypt(sealed, 'other-key'));
});
