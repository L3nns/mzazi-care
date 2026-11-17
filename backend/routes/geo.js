/**
 * Place search for the map on the search page. See services/geocoder.js for
 * what is matched locally and what is asked of OpenStreetMap.
 */
const express = require('express');
const { query: q } = require('express-validator');
const { handleValidation } = require('../middleware/validate');
const { asyncRoute } = require('../middleware/errors');
const areas = require('../services/areas');
const geocoder = require('../services/geocoder');

const router = express.Router();

router.get(
  '/search',
  [q('q').trim().isLength({ min: 2, max: 120 }).withMessage('type at least 2 characters')],
  handleValidation,
  asyncRoute(async (req, res) => {
    const list = await areas.listAreas();
    const out = await geocoder.searchPlaces(req.query.q, list);
    res.json(out);
  }),
);

module.exports = router;
