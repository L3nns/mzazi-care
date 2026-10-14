/**
 * Catalogue helpers shared by the search, recommendation and admin routes:
 * keyword-search SQL, category expansion, and hydrating engine results with
 * the listing details the cards need.
 */
const { query } = require('../config/db');

// Spelling variants the listings mix freely ("day care", "day-care",
// "daycare"). Mirrors ml-service/synonyms.py so search and the recommender
// agree on what one term is (Section 3.2.2).
const VARIANTS = [
  ['childcare', 'child care'], ['daycare', 'day care'], ['healthcare', 'health care'],
  ['breastfeeding', 'breast feeding'], ['breastfeed', 'breast feed'],
  ['antenatal', 'ante natal'], ['prenatal', 'pre natal'], ['postnatal', 'post natal'],
  ['postpartum', 'post partum'], ['newborn', 'new born'],
  ['childminder', 'child minder'], ['preschool', 'pre school'],
];
const COMPACT = new Map(VARIANTS);

// InnoDB's default full-text stopwords plus filler words people type into a
// search box. Dropped from the AND-match, still used for relevance.
const STOPWORDS = new Set(`a about an and are as at be by com de en for from how i in
  is it la of on or that the this to was what when where who will with und www me my
  we our you your someone somebody need needs looking find near help want please`
  .split(/\s+/));

/** Lowercase, hyphens to spaces, variants collapsed, then usable tokens. */
function searchTerms(text) {
  let t = String(text || '').toLowerCase().replace(/[-_]+/g, ' ');
  for (const [compact, spaced] of VARIANTS) {
    t = t.replace(new RegExp(`\\b${spaced.replace(' ', '\\s+')}\\b`, 'g'), compact);
  }
  return [...new Set(t.replace(/[^\p{L}\p{N}\s]+/gu, ' ').split(/\s+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w)))];
}

/**
 * SQL for a keyword search over providers p JOIN categories c. Every usable
 * term must match (AND), by prefix, in the description, tags, name or
 * category; a variant term also matches its spaced spelling. Returns
 * { where, params, score, scoreParams }.
 */
function keywordSql(text) {
  const FT = 'MATCH(p.service_description, p.service_tags) AGAINST (? IN BOOLEAN MODE)';
  const terms = searchTerms(text);
  const parts = [];
  const params = [];
  for (const term of terms) {
    const alts = [`${FT} > 0`, 'p.provider_name LIKE ?', 'c.category_name LIKE ?'];
    const p = [`+${term}*`, `%${term}%`, `%${term}%`];
    if (COMPACT.has(term)) {
      const spaced = COMPACT.get(term);
      alts.push(`${FT} > 0`, 'p.provider_name LIKE ?', 'c.category_name LIKE ?');
      p.push(`"${spaced}"`, `%${spaced}%`, `%${spaced}%`);
    }
    parts.push(`(${alts.join(' OR ')})`);
    params.push(...p);
  }
  // A literal name match always qualifies, whatever the tokens did.
  const where = parts.length
    ? `((${parts.join(' AND ')}) OR p.provider_name LIKE ?)`
    : 'p.provider_name LIKE ?';
  params.push(`%${text}%`);
  const score = `(MATCH(p.service_description, p.service_tags) AGAINST (? IN NATURAL LANGUAGE MODE)
      + (p.provider_name LIKE ?) * 5 + (c.category_name LIKE ?) * 3)`;
  return { where, params, score, scoreParams: [String(text), `%${text}%`, `%${text}%`] };
}

/** A category id plus its children, so a parent ("service type") filters its tree. */
const CATEGORY_TREE_SQL = 'p.category_id IN (SELECT category_id FROM categories WHERE category_id = ? OR parent_category_id = ?)';

/**
 * search_history.category_filter holds a category id written by the app, or a
 * category name in the seeded rows. Joins categories `c` to alias `s` on either,
 * without a string cast whose collation would clash with the column's.
 */
const CATEGORY_FILTER_JOIN = `(c.category_name = s.category_filter
  OR (s.category_filter REGEXP '^[0-9]+$' AND c.category_id = CAST(s.category_filter AS UNSIGNED)))`;

/** Rating summary columns for a providers alias `p`. */
const RATING_COLUMNS = `
  (SELECT ROUND(AVG(r.rating_value), 1) FROM interactions r
    WHERE r.provider_id = p.provider_id AND r.interaction_type = 'rating') AS avg_rating,
  (SELECT COUNT(*) FROM interactions r
    WHERE r.provider_id = p.provider_id AND r.interaction_type = 'rating') AS rating_count`;

/** Adds the listing details cards need to bare engine results. */
async function hydrate(results) {
  if (!results?.length) return [];
  const ids = results.map((r) => r.provider_id);
  const details = await query(
    `SELECT p.provider_id, p.service_tags, p.service_description, p.location,
            p.qualifications, p.verification_status
     FROM providers p WHERE p.provider_id IN (${ids.map(() => '?').join(',')})`,
    ids,
  );
  const byId = Object.fromEntries(details.map((d) => [d.provider_id, d]));
  return results.map((r) => ({ ...r, ...(byId[r.provider_id] || {}) }));
}

/** "Popular and highly rated" straight from SQL, for when the engine is down. */
async function popularSql({ topN = 10, category = null, location = null, excludeUser = null } = {}) {
  const where = ["p.verification_status = 'verified'"];
  const params = [];
  if (category) { where.push(CATEGORY_TREE_SQL); params.push(category, category); }
  if (location) { where.push('p.location = ?'); params.push(location); }
  if (excludeUser) {
    where.push('p.provider_id NOT IN (SELECT provider_id FROM saved_services WHERE user_id = ?)');
    params.push(excludeUser);
  }
  const rows = await query(
    `SELECT p.provider_id, p.provider_name, p.category_id, c.category_name, p.location,
            p.service_tags, p.verification_status,
            COUNT(i.interaction_id) AS interaction_count,
            ROUND(AVG(CASE WHEN i.interaction_type = 'rating' THEN i.rating_value END), 1) AS avg_rating
     FROM providers p
     JOIN categories c ON c.category_id = p.category_id
     LEFT JOIN interactions i ON i.provider_id = p.provider_id
     WHERE ${where.join(' AND ')}
     GROUP BY p.provider_id
     ORDER BY COALESCE(AVG(CASE WHEN i.interaction_type = 'rating' THEN i.rating_value END), 3)
              * LOG(2 + COUNT(i.interaction_id)) DESC, p.provider_name
     LIMIT ?`, [...params, String(topN)],
  );
  return rows.map((r, i) => ({ ...r, rank_position: i + 1, basis: 'popular' }));
}

module.exports = {
  searchTerms, keywordSql, hydrate, popularSql, CATEGORY_TREE_SQL, RATING_COLUMNS,
  CATEGORY_FILTER_JOIN,
};
