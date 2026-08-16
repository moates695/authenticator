/**
 * A promise that can be asked whether it has finished, without being waited on.
 *
 * The registration flow needs this: the code screen has to know whether the
 * background key derivation is already done before it decides how to spend the
 * typed code, and awaiting to find out is the very wait it is trying to avoid.
 */
export type Peekable<T> = {
  promise: Promise<T>;
  /** True once the underlying promise has settled, either way. */
  ready: () => boolean;
};

export function peekable<T>(promise: Promise<T>): Peekable<T> {
  let done = false;
  // A rejection counts as finished too: whoever awaits learns why, and the
  // point of asking is only ever "is there still a wait here?".
  const watched = promise.then(
    (value) => {
      done = true;
      return value;
    },
    (err) => {
      done = true;
      throw err;
    },
  );
  // The caller may never await it, and an unhandled rejection is not how this
  // should be reported.
  watched.catch(() => {});
  return { promise: watched, ready: () => done };
}
