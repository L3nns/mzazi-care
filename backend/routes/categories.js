/** The service category tree (FR-03). Public. */
const express = require('express');
const { query } = require('../config/db');
const { asyncRoute } = require('../middleware/errors');

const router = express.Router();

router.get('/', asyncRoute(async (_req, res) => {
  const rows = await query(
    `SELECT c.category_id, c.category_name, c.description, c.parent_category_id,
            (SELECT COUNT(*) FROM providers p
              WHERE p.category_id = c.category_id
                AND p.verification_status = 'verified') AS provider_count
     FROM categories c
     ORDER BY COALESCE(c.parent_category_id, c.category_id), c.category_id`,
  );
  const parents = rows.filter((r) => r.parent_category_id === null);
  const tree = parents.map((p) => ({
    ...p,
    children: rows.filter((c) => c.parent_category_id === p.category_id),
  }));
  res.json({ categories: rows, tree });
}));

module.exports = router;
