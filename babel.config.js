const path = require('path');

/**
 * Where imports of `@noble/hashes/utils.js` are really sent, and why: noble's
 * async Argon2id pauses with that module's `nextTick`, a bare microtask that
 * starves the event loop and freezes the app for the whole derivation. Metro
 * compiles ESM exports to read-only live bindings, so the replacement cannot
 * be installed at runtime — it has to happen here, where both Metro and Jest
 * will see it. The shim re-exports the real module with only `nextTick`
 * swapped; see src/sync/js_thread.ts for the full story.
 */
const NOBLE_UTILS_SHIM = path.resolve(__dirname, 'src/sync/noble_utils_shim');
const NOBLE_HASHES_DIR = path.join('node_modules', '@noble', 'hashes');

function resolveNobleUtils(sourcePath, currentFile) {
  const targetsNobleUtils =
    sourcePath === '@noble/hashes/utils.js' ||
    // noble's own modules (argon2.js among them) reach utils relatively.
    (sourcePath === './utils.js' && path.dirname(currentFile).endsWith(NOBLE_HASHES_DIR));
  if (!targetsNobleUtils) return undefined;

  // The shim's own star re-export is the one import that must reach the real
  // module, or it would only ever re-export itself.
  if (currentFile.startsWith(NOBLE_UTILS_SHIM)) return undefined;

  return NOBLE_UTILS_SHIM;
}

module.exports = function (api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
    plugins: [
      ['module-resolver', { resolvePath: resolveNobleUtils }],
      'react-native-worklets/plugin',
    ],
  };
};
