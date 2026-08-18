/**
 * What every import of `@noble/hashes/utils.js` actually resolves to, put in
 * place by the `module-resolver` alias in babel.config.js. The alias skips this
 * file itself, so the star re-export below reaches the real module.
 *
 * It exists to change one export: `nextTick`, which noble's `argon2idAsync`
 * pauses with between blocks. The original is a bare microtask, and a
 * derivation that pauses only with microtasks never hands the event loop a
 * turn — no renders, no touches, an app frozen for the length of an Argon2id
 * run (see js_thread.ts for the full story).
 *
 * Substituting at build time, rather than assigning over the export at
 * runtime, is forced by Metro: with import support on (the Expo SDK 53+
 * default) every ESM export becomes a getter-only live binding, and writing to
 * one throws. Jest and Metro both read babel.config.js, so both resolve to
 * this shim and both run the derivation exactly as the device does — which is
 * what lets the test in js_thread.test.ts stand in for a phone.
 */
export * from '@noble/hashes/utils.js';
export { throttledYield as nextTick } from './js_thread';
