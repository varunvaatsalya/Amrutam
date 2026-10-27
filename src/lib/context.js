// Per-request context (trace id) without threading it through every call.
// Follows W3C traceparent so an upstream gateway / APM can stitch spans together.
const { AsyncLocalStorage } = require('async_hooks');
const crypto = require('crypto');

const als = new AsyncLocalStorage();

const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/;

function parseTraceparent(header) {
  const m = header && TRACEPARENT.exec(header);
  return m ? m[1] : null;
}

const newTraceId = () => crypto.randomBytes(16).toString('hex');
const newSpanId = () => crypto.randomBytes(8).toString('hex');

const run = (ctx, fn) => als.run(ctx, fn);
const current = () => als.getStore() || {};

module.exports = { parseTraceparent, newTraceId, newSpanId, run, current };
