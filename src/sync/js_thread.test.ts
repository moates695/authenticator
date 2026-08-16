import { argon2idAsync } from '@noble/hashes/argon2.js';
import * as nobleUtils from '@noble/hashes/utils.js';

import {
  YIELD_BUDGET_MS,
  installEventLoopYield,
  throttledYield,
  yieldToEventLoop,
} from './js_thread';

/** The yield noble ends up calling, once it has been installed over the export. */
function installedYield(): () => Promise<void> {
  installEventLoopYield();
  return (nobleUtils as unknown as { nextTick: () => Promise<void> }).nextTick;
}

const realSetTimeout = global.setTimeout;

/**
 * Node answers `setTimeout(…, 0)` in about a millisecond. A phone does not: it
 * is a round trip through the native timer queue, and tens of milliseconds is
 * ordinary — which is the whole reason the yield has to be throttled here rather
 * than left to noble's `asyncTick`.
 *
 * Returns how many real yields were taken, live, so an assertion can be made
 * while the derivation is still running rather than after it has taken an hour.
 */
function withPhoneTimers(latencyMs: number, cap: number): { yields: () => number; undo: () => void } {
  let count = 0;
  global.setTimeout = ((callback: () => void) => {
    if (++count > cap) {
      throw new Error(`yielded more than ${cap} times; the throttle is not holding`);
    }
    return realSetTimeout(callback, latencyMs);
  }) as unknown as typeof global.setTimeout;

  return {
    yields: () => count,
    undo: () => {
      global.setTimeout = realSetTimeout;
    },
  };
}

describe('yielding the JS thread', () => {
  it('lets a pending timer run, which awaiting a resolved promise does not', async () => {
    let fired = false;
    setTimeout(() => {
      fired = true;
    }, 0);

    // What @noble/hashes yields with. The microtask queue is drained before the
    // event loop is looked at again, so nothing else gets a turn.
    await Promise.resolve();
    expect(fired).toBe(false);

    await yieldToEventLoop();
    expect(fired).toBe(true);
  });
});

describe('the babel alias', () => {
  it('resolves noble utils to the shim, before anything installs it', () => {
    // Jest and Metro both read babel.config.js, so this is the device's bundle
    // being asserted on, not a test-only arrangement: noble's argon2 imports
    // `nextTick` from this module, and it must already be the throttled yield.
    // Metro's exports are read-only, so no runtime install can save a bundle
    // where the alias has gone missing — a red here is an app that freezes for
    // the length of an Argon2id derivation every time an account is created.
    expect((nobleUtils as unknown as { nextTick: unknown }).nextTick).toBe(throttledYield);
  });
});

describe('installing the yield', () => {
  it('takes, so a derivation is not left holding the thread', () => {
    // A false here means neither the alias nor the assignment reached noble,
    // and every sign-in freezes the app for the length of a derivation.
    expect(installEventLoopYield()).toBe(true);
  });

  it('is safe to call before every derivation', () => {
    expect(installEventLoopYield()).toBe(true);
    expect(installEventLoopYield()).toBe(true);
  });

  it('replaces the export noble actually calls', () => {
    expect(installedYield()).not.toBe(nobleUtils.nextTick.constructor.prototype);
    expect(typeof installedYield()).toBe('function');
  });
});

describe('throttling the yield', () => {
  it('hands the thread back at most once per budget, however often it is asked', async () => {
    const nextTick = installedYield();
    const timers = withPhoneTimers(0, 1000);

    try {
      // Asked far more often than the budget allows, which is what noble does
      // once a pause has put the following block over its own tick.
      const started = Date.now();
      let asks = 0;
      while (Date.now() - started < YIELD_BUDGET_MS * 3) {
        await nextTick();
        asks++;
      }

      expect(asks).toBeGreaterThan(50);
      // Three budgets' worth of asking, so three or four real yields — not one
      // per ask.
      expect(timers.yields()).toBeLessThanOrEqual(5);
    } finally {
      timers.undo();
    }
  });

  it('still yields for real, rather than only pretending to', async () => {
    const nextTick = installedYield();

    // The throttle counts from the last real yield, which the test above just
    // took. Wait the budget out so this ask is one it should grant.
    await new Promise((resolve) => setTimeout(resolve, YIELD_BUDGET_MS + 10));

    let fired = false;
    setTimeout(() => {
      fired = true;
    }, 0);

    await nextTick();
    expect(fired).toBe(true);
  });
});

describe('a derivation on a device with slow timers', () => {
  // Small enough to finish quickly while still running long enough to need
  // several pauses. The real parameters are 64x this.
  const BLOCKS = 2048 * 4;

  it('yields with the clock, not with the block count', async () => {
    installEventLoopYield();

    // 25ms is past the point where noble's own accounting starts charging the
    // pause to the next block and pausing after every one of them. Before the
    // throttle this took one yield per block, all 8192 of them; the cap fails
    // the test in seconds rather than letting it run for minutes.
    const timers = withPhoneTimers(25, 60);

    let derived: Uint8Array;
    const started = Date.now();
    try {
      derived = await argon2idAsync('a test passphrase', new Uint8Array(32), {
        t: 4,
        m: 2048,
        p: 1,
        dkLen: 32,
        // Deliberately the tick that provoked the freeze, rather than the one
        // `keys.ts` now passes: what holds the pauses down is the throttle, and
        // raising the tick as well should not be what this depends on.
        asyncTick: 20,
      });
    } finally {
      timers.undo();
    }

    // Whatever the pauses cost, the key is the same one.
    expect(derived).toHaveLength(32);

    const elapsed = Date.now() - started;
    // The bound that matters: yields track time held, not blocks processed.
    expect(timers.yields()).toBeLessThanOrEqual(Math.ceil(elapsed / YIELD_BUDGET_MS) + 2);
    expect(timers.yields()).toBeLessThan(BLOCKS / 100);
  });
});
