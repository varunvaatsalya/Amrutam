const test = require('node:test');
const assert = require('node:assert');
const { canTransition, assertTransition } = require('../../src/modules/consultations/stateMachine');

test('happy path is allowed', () => {
  assert.ok(canTransition('pending', 'confirmed'));
  assert.ok(canTransition('confirmed', 'in_progress'));
  assert.ok(canTransition('in_progress', 'completed'));
});

test('cannot skip steps or leave terminal states', () => {
  assert.ok(!canTransition('pending', 'in_progress'));
  assert.ok(!canTransition('confirmed', 'completed'));
  assert.ok(!canTransition('in_progress', 'cancelled'));
  for (const terminal of ['completed', 'cancelled', 'no_show']) {
    assert.ok(!canTransition(terminal, 'confirmed'));
  }
});

test('assertTransition throws a 409', () => {
  assert.throws(() => assertTransition('completed', 'cancelled'), (err) => err.status === 409 && err.code === 'INVALID_STATE_TRANSITION');
});
