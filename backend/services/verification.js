/**
 * Provider verification: the states a listing moves through, which moves are
 * allowed, and which documents each service category requires.
 *
 *   draft -> pending -> under_review -> verified
 *                            |  \-> needs_more_information -> under_review
 *                            \-> rejected -> pending (resubmission)
 *   verified -> suspended -> under_review
 *   verified -> expired   -> under_review   (a required document lapsed)
 *
 * `verified` is the APPROVED state. Only verified listings are searchable or
 * recommendable; every public query filters on it, so a suspended or expired
 * listing drops out however well it would score.
 */

const STATES = ['draft', 'pending', 'under_review', 'needs_more_information',
  'verified', 'rejected', 'suspended', 'expired'];

const LABELS = {
  draft: 'Draft',
  pending: 'Pending',
  under_review: 'Under review',
  needs_more_information: 'Needs more information',
  verified: 'Verified',
  rejected: 'Rejected',
  suspended: 'Suspended',
  expired: 'Expired',
};

const TRANSITIONS = {
  draft: ['pending'],
  pending: ['under_review'],
  under_review: ['verified', 'rejected', 'needs_more_information'],
  needs_more_information: ['under_review'],
  rejected: ['pending'],
  verified: ['suspended', 'expired'],
  suspended: ['under_review'],
  expired: ['under_review'],
};

/** Moves that must say why, so the provider knows what to fix. */
const REASON_REQUIRED = new Set(['rejected', 'needs_more_information', 'suspended']);

/** The listing statuses an administrator still has to act on. */
const QUEUE = ['pending', 'under_review'];

/**
 * The steps from one state to another. A decision on a listing that is not yet
 * under review opens the review first, so one click records both steps and
 * the history still shows the review. Returns null if the move is not allowed.
 */
function plan(from, to) {
  if (!STATES.includes(from) || !STATES.includes(to) || from === to) return null;
  if (TRANSITIONS[from].includes(to)) return [to];
  if (TRANSITIONS[from].includes('under_review') && TRANSITIONS.under_review.includes(to)) {
    return ['under_review', to];
  }
  return null;
}

/** Every state reachable from `from` in one action, direct or via review. */
const nextStates = (from) => STATES.filter((to) => plan(from, to));

/* ------------------------------------------------------------ documents */
const DOCUMENT_TYPES = {
  identity: 'Identity document',
  qualification: 'Qualification certificate',
  professional_registration: 'Professional registration',
  business_registration: 'Business registration',
  facility_licence: 'Facility licence',
  other: 'Other supporting document',
};

/** Used when neither the category nor its parent says otherwise. */
const DEFAULT_REQUIRED = ['identity'];

const parseList = (s) => String(s || '').split(',').map((t) => t.trim())
  .filter((t) => t && DOCUMENT_TYPES[t] && t !== 'other');

/**
 * The document types a category requires: its own list, else its parent's,
 * else the default. `categories` maps id -> { required_documents, parent_category_id }.
 */
function requiredFor(categoryId, categories) {
  const own = categories.get(Number(categoryId));
  if (own && parseList(own.required_documents).length) return parseList(own.required_documents);
  const parent = own && own.parent_category_id ? categories.get(Number(own.parent_category_id)) : null;
  if (parent && parseList(parent.required_documents).length) return parseList(parent.required_documents);
  return [...DEFAULT_REQUIRED];
}

/**
 * A stored DATE as 'YYYY-MM-DD'. The MySQL pool runs in UTC, so a DATE comes
 * back as a Date at UTC midnight and its UTC calendar day is the stored day.
 */
const isoDay = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));

/**
 * Today's date where the platform operates (the server's local time zone,
 * which matches MySQL's CURDATE()). Using the UTC date instead would keep an
 * expired document valid for the first hours of each day in Nairobi (UTC+3).
 */
const localDay = (d = new Date()) => {
  if (!(d instanceof Date)) return String(d).slice(0, 10);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

/** A document counts if it was accepted and has not expired. */
function isValid(doc, today = new Date()) {
  if (doc.review_status !== 'accepted') return false;
  return !doc.expires_on || isoDay(doc.expires_on) >= localDay(today);
}

/** Required types with no valid document. */
function missingDocuments(required, docs, today = new Date()) {
  return required.filter((type) => !docs.some((d) => d.document_type === type && isValid(d, today)));
}

/**
 * Required types that WERE covered by an accepted document that has since
 * expired, with nothing valid in its place. These, not documents that were
 * never supplied, are what move a verified listing to `expired`.
 */
function lapsedDocuments(required, docs, today = new Date()) {
  return required.filter((type) => {
    const ofType = docs.filter((d) => d.document_type === type && d.review_status === 'accepted');
    return ofType.length && !ofType.some((d) => isValid(d, today));
  });
}

module.exports = {
  STATES, LABELS, TRANSITIONS, REASON_REQUIRED, QUEUE, plan, nextStates,
  DOCUMENT_TYPES, DEFAULT_REQUIRED, requiredFor, missingDocuments, lapsedDocuments, isValid, isoDay, localDay,
};
