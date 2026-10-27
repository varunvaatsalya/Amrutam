const { Router } = require('express');
const { validate } = require('../../middleware/validate');
const schemas = require('./auth.schemas');

function authRoutes({ authService, authenticate, strictLimiter }) {
  const r = Router();

  r.post('/register', strictLimiter, validate({ body: schemas.register }), async (req, res) => {
    const user = await authService.register(req.valid.body, req.auditCtx());
    res.status(201).json({ user });
  });

  r.post('/login', strictLimiter, validate({ body: schemas.login }), async (req, res) => {
    res.json(await authService.login(req.valid.body, req.auditCtx()));
  });

  r.post('/refresh', strictLimiter, validate({ body: schemas.refresh }), async (req, res) => {
    res.json(await authService.refresh(req.valid.body.refreshToken, req.auditCtx()));
  });

  r.post('/logout', validate({ body: schemas.refresh }), async (req, res) => {
    await authService.logout(req.valid.body.refreshToken, req.auditCtx());
    res.status(204).end();
  });

  r.post('/mfa/setup', authenticate, async (req, res) => {
    res.json(await authService.setupMfa(req.user.id));
  });

  r.post('/mfa/enable', authenticate, strictLimiter, validate({ body: schemas.mfaCode }), async (req, res) => {
    res.json(await authService.enableMfa(req.user.id, req.valid.body.code, req.auditCtx()));
  });

  r.get('/me', authenticate, async (req, res) => {
    res.json(await authService.me(req.user.id));
  });

  return r;
}

module.exports = { authRoutes };
