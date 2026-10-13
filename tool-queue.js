'use strict';

/**
 * tool-queue.js — tool calls run one at a time, in the order they arrive (design D11).
 *
 * The tools share the inbox cursor and the read and push records, and a host may send calls together:
 * a sym_fetch sent behind a sym_receive must not run first and mark as read what the receive was about
 * to list. A call that never settles must not hold every later call forever, so the next call may
 * start `holdMs` after the hung one STARTED (review L1: v1 started the timer when a call was queued,
 * so a hung call released every call queued behind it at once, and they ran together, out of order).
 */

function createToolQueue({ holdMs = 60_000 } = {}) {
  let tail = Promise.resolve();
  return function enqueue(task) {
    let release;
    const gate = new Promise((r) => { release = r; });
    const prev = tail;
    tail = gate;
    return prev.then(async () => {
      const t = setTimeout(release, holdMs);
      if (t.unref) t.unref();
      try { return await task(); }
      finally { clearTimeout(t); release(); }
    });
  };
}

module.exports = { createToolQueue };
