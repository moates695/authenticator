/**
 * What every import of `@noble/hashes/utils.js` actually resolves to, put in
 * place by the `module-resolver` alias in babel.config.js. The alias skips this
 * file itself, so the star re-export below reaches the real module.
 *
 * It exists to change two exports, which are the two ways a derivation in
 * keys.ts pauses. `nextTick` is what noble's `argon2idAsync` pauses with
 * between blocks; the original is a bare microtask, and a derivation that
 * pauses only with microtasks never hands the event loop a turn — no renders,
 * no touches, an app frozen for the length of the run. `asyncLoop` is what
 * `scryptAsync` drives its main loops through, and it has to be replaced whole
 * rather than by way of `nextTick`: it lives inside utils.js and calls the
 * module-local copy, which no export substitution can reach (see js_thread.ts
 * for the full story).
 *
 * Substituting at build time, rather than assigning over the export at
 * runtime, is forced by Metro: with import support on (the Expo SDK 53+
 * default) every ESM export becomes a getter-only live binding, and writing to
 * one throws. Jest and Metro both read babel.config.js, so both resolve to
 * this shim and both run the derivation exactly as the device does — which is
 * what lets the test in js_thread.test.ts stand in for a phone.
 */
export * from '@noble/hashes/utils.js';
// Explicit named exports win over the star above, which is what makes this a
// substitution rather than a duplicate export.
export { throttledYield as nextTick, throttledAsyncLoop as asyncLoop } from './js_thread';
