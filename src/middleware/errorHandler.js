const { AppError } = require('../lib/errors');

function notFoundHandler(req, res) {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: `No route for ${req.method} ${req.path}` } });
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  if (err instanceof AppError) {
    return res.status(err.status).json({
      error: { code: err.code, message: err.message, details: err.details },
    });
  }

  // malformed json body from express.json()
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Malformed JSON body' } });
  }
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'Body too large' } });
  }

  (req.log || console).error({ err }, 'unhandled error');
  res.status(500).json({ error: { code: 'INTERNAL', message: 'Something went wrong', requestId: req.id } });
}

module.exports = { errorHandler, notFoundHandler };
