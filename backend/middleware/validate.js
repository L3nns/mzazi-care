const { validationResult } = require('express-validator');

/** Turns express-validator failures into a 422 with a readable field list. */
function handleValidation(req, res, next) {
  const result = validationResult(req);
  if (result.isEmpty()) return next();
  return res.status(422).json({
    error: 'validation failed',
    details: result.array().map((e) => ({ field: e.path, message: e.msg })),
  });
}

module.exports = { handleValidation };
