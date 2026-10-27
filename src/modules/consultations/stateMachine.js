const { conflict } = require('../../lib/errors');

//  pending --pay--> confirmed --start--> in_progress --complete--> completed
//     |                 |  \
//     +--cancel/expire--+   +--no_show (doctor, after start time)
const TRANSITIONS = {
  pending: ['confirmed', 'cancelled'],
  confirmed: ['in_progress', 'cancelled', 'no_show'],
  in_progress: ['completed'],
  completed: [],
  cancelled: [],
  no_show: [],
};

const canTransition = (from, to) => TRANSITIONS[from]?.includes(to) ?? false;

function assertTransition(from, to) {
  if (!canTransition(from, to)) {
    throw conflict(`Cannot move consultation from ${from} to ${to}`, 'INVALID_STATE_TRANSITION');
  }
}

module.exports = { TRANSITIONS, canTransition, assertTransition };
