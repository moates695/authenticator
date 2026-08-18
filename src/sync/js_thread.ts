import * as nobleUtils from '@noble/hashes/utils.js';

/**
 * Keeping the app alive while a key is being derived.
 *
 * A password KDF is expensive on purpose, and there is nowhere else to run it:
 * Hermes has no JIT, Expo Go rules out a native implementation, and a worklet
 * runtime cannot reach an imported module. So it runs on the JS thread for as
 * long as it takes, and the only thing that keeps the app usable meanwhile is
 * how often it hands that thread back.
 *
 * @noble/hashes has an async variant for exactly this, taking an `asyncTick` and
 * pausing between blocks. What it pauses with is:
 *
 *     export const nextTick = async () => {};
 *
 * Awaiting that queues a microtask, and the microtask queue is drained to empty
 * before the event loop gets another turn. Each continuation queues the next
 * one, so the queue never empties and the turn never comes: for the whole
 * derivation there are no renders, no touches and no timers. The progress bar it
 * exists to drive cannot move, and Android takes an app that has ignored input
 * for half a minute to be one that has stopped responding.
 *
 * Swapping it for a real yield changes nothing about the derivation — the same
 * blocks in the same order, the same key out — only when the thread is given
 * back. The swap happens at build time: Metro compiles every ESM export to a
 * read-only live binding (a getter with no setter), so noble's `nextTick`
 * cannot be assigned over at runtime. Instead the `module-resolver` alias in
 * babel.config.js resolves every import of `@noble/hashes/utils.js` to
 * `noble_utils_shim.ts`, which re-exports the real module with `nextTick` — and
 * `asyncLoop`, the second way in, for the reasons under `throttledAsyncLoop` —
 * replaced by the throttled versions below. Jest reads the same babel config,
 * so the tests run against the same substitution the device does.
 *
 * The yield cannot be a naive one either, because of how noble decides when to
 * call it:
 *
 *     const diff = Date.now() - ts;
 *     if (!(diff >= 0 && diff < asyncTick)) { await nextTick(); ts += diff; }
 *
 * `ts` is advanced to the reading taken *before* the pause, so the next block
 * measures its own cost plus however long the pause itself took. A microtask
 * costs nothing and this works out. A real yield does not: on a phone it is a
 * round trip through the native timer queue, tens of milliseconds, and once that
 * exceeds `asyncTick` every block after the first is over budget before it
 * starts. noble then pauses after every single block — 262144 of them at the
 * parameters in `keys.ts` — and a derivation that should take a few seconds
 * takes closer to an hour. Traded one freeze for a longer one.
 *
 * So the throttle lives here rather than in noble's accounting. However often
 * noble asks, the thread is genuinely handed back at most once per
 * `YIELD_BUDGET_MS` of work; the rest of the asks are the cheap microtask it
 * already expects. That holds whatever a given device's timers cost, which is
 * the part we cannot measure from here and should not have to guess at.
 */

/**
 * How long a derivation may hold the JS thread between real yields, in ms.
 *
 * Ten repaints a second: enough for the progress bar to move smoothly and for a
 * touch to be answered promptly, while the pauses stay a small fraction of the
 * total. Lower is more responsive and slower overall, since each pause costs
 * whatever the device's timer round trip costs.
 *
 * Also handed to noble as its `asyncTick`, so in the ordinary case it asks to
 * pause at about the rate the throttle would allow anyway.
 */
export const YIELD_BUDGET_MS = 100;

/** A pause the event loop gets a turn on, rather than only the microtask queue. */
export function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

/** When the last real yield handed the thread back. */
let resumedAt = 0;

/**
 * What noble ends up calling, via the shim. A real yield if the thread has been
 * held for the budget, and otherwise the microtask it would have got anyway.
 */
export async function throttledYield(): Promise<void> {
  const held = Date.now() - resumedAt;
  // Date.now() is not monotonic; a clock that has gone backwards yields rather
  // than waiting out the difference, which is what noble does with its own.
  if (held >= 0 && held < YIELD_BUDGET_MS) return;

  await yieldToEventLoop();
  resumedAt = Date.now();
}

/**
 * What noble's `asyncLoop` becomes, via the shim. `scryptAsync` drives its two
 * main loops through this, and unlike `argon2idAsync` it cannot be reached by
 * replacing an export: the original calls the `nextTick` local to utils.js, not
 * the one imported from it.
 *
 * Same loop, with two differences. It pauses through `throttledYield`, so the
 * thread is genuinely handed back at most once per budget however often this
 * asks. And it takes a fresh clock reading after a pause rather than noble's
 * `ts += diff`, which credits `ts` with the time up to the pause but not the
 * pause itself — on a device, where a real yield costs tens of milliseconds,
 * that leaves every following iteration over budget the moment it starts and
 * turns the check below into a formality. The throttle would absorb it, but at
 * a wasted microtask per iteration, and there are a quarter of a million of
 * them.
 */
export async function throttledAsyncLoop(
  iterations: number,
  tick: number,
  callback: (index: number) => void,
): Promise<void> {
  let ts = Date.now();
  for (let index = 0; index < iterations; index++) {
    callback(index);
    // Date.now() is not monotonic; a clock that has gone backwards pauses
    // rather than waiting out the difference, which is what noble does.
    const held = Date.now() - ts;
    if (held >= 0 && held < tick) continue;
    await throttledYield();
    ts = Date.now();
  }
}

type Yielding = {
  nextTick: () => Promise<void>;
  asyncLoop: (iterations: number, tick: number, callback: (index: number) => void) => Promise<void>;
};

let installed: boolean | null = null;

/**
 * Confirms the throttled yield is what noble will pause with. Idempotent, and
 * safe to call from anything about to derive.
 *
 * In any bundle built through babel.config.js the alias has already put the
 * shim in place and this only verifies it. The assignment is a fallback for
 * environments the alias does not reach, and under Metro it cannot succeed —
 * exports there are getter-only, which is exactly why the alias exists. A
 * false from here means a derivation will hold the JS thread from the first
 * block to the last and freeze the app — worth a red test rather than a phone
 * that has to be force-quit.
 *
 * Two entry points are covered, because the two KDFs in `keys.ts` pause through
 * different ones. `argon2idAsync` imports `nextTick` from utils, so replacing
 * that export reaches it. `scryptAsync` instead calls `asyncLoop`, which lives
 * inside utils and pauses with its *module-local* `nextTick` — an export
 * replacement cannot reach inside it. So the shim replaces `asyncLoop` itself
 * with `throttledAsyncLoop` below, which is the same loop pausing through the
 * same throttle. `pbkdf2Async` goes through `asyncLoop` too and so comes along
 * for free.
 */
export function installEventLoopYield(): boolean {
  if (installed !== null) return installed;

  const utils = nobleUtils as unknown as Yielding;
  // Both, because which one a derivation pauses through depends on its
  // algorithm: Argon2id reaches `nextTick`, scrypt reaches `asyncLoop`, and an
  // account made under one may be signed into on a device deriving the other.
  if (utils.nextTick === throttledYield && utils.asyncLoop === throttledAsyncLoop) {
    installed = true;
    return installed;
  }

  try {
    utils.nextTick = throttledYield;
    utils.asyncLoop = throttledAsyncLoop;
    installed = utils.nextTick === throttledYield && utils.asyncLoop === throttledAsyncLoop;
  } catch {
    installed = false;
  }
  return installed;
}
