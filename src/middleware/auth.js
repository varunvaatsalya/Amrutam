const jwt = require('jsonwebtoken');
const { AppError, unauthorized, forbidden } = require('../lib/errors');

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
      req.user = { id: payload.sub, role: payload.role, mfa: payload.mfa === true };
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

// staff touching PHI (prescriptions, admin) must have logged in with MFA.
// token claim is set at login, so after enabling MFA the user logs in again.
const requireMfa = (config) => (req, res, next) => {
  if (!config.requireStaffMfa || req.user?.role === 'patient' || req.user?.mfa) return next();
  next(new AppError(403, 'MFA_REQUIRED', 'Enable MFA (/auth/mfa/setup) and log in again'));
};

module.exports = { authenticate, requireRole, requireMfa };
