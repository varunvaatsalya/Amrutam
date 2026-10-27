const jwt = require('jsonwebtoken');
const { unauthorized, forbidden } = require('../lib/errors');

function authenticate(config) {
  return (req, res, next) => {
    const header = req.get('authorization') || '';
    const [scheme, token] = header.split(' ');
    if (scheme !== 'Bearer' || !token) return next(unauthorized('Missing bearer token'));

    try {
      const payload = jwt.verify(token, config.jwt.accessSecret, {
        algorithms: ['HS256'],
        issuer: 'amrutam-api',
      });
      req.user = { id: payload.sub, role: payload.role };
      next();
    } catch {
      next(unauthorized('Invalid or expired token'));
    }
  };
}

const requireRole = (...roles) => (req, res, next) => {
  if (!req.user) return next(unauthorized());
  if (!roles.includes(req.user.role)) return next(forbidden(`Requires role: ${roles.join(' or ')}`));
  next();
};

module.exports = { authenticate, requireRole };
