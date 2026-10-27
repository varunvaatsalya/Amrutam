const { badRequest } = require('../lib/errors');

// validate({ body, query, params }) - parsed values end up on req.valid
function validate(schemas) {
  return (req, res, next) => {
    req.valid = {};
    for (const part of ['params', 'query', 'body']) {
      if (!schemas[part]) continue;
      const result = schemas[part].safeParse(req[part] ?? {});
      if (!result.success) {
        const details = result.error.issues.map((i) => ({ field: [part, ...i.path].join('.'), message: i.message }));
        return next(badRequest('Validation failed', details));
      }
      req.valid[part] = result.data;
    }
    next();
  };
}

module.exports = { validate };
