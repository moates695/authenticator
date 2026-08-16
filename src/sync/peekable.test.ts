import { peekable } from './peekable';

/** Lets every already-queued microtask run, which is all `ready()` waits on. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('peekable', () => {
  it('is not ready while the promise is still running', async () => {
    let finish = (_: string) => {};
    const peeked = peekable(new Promise<string>((resolve) => (finish = resolve)));

    await settle();
    expect(peeked.ready()).toBe(false);

    finish('done');
    await settle();
    expect(peeked.ready()).toBe(true);
  });

  it('passes the value through', async () => {
    await expect(peekable(Promise.resolve(7)).promise).resolves.toBe(7);
  });

  it('counts a failure as finished, and still reports it to whoever awaits', async () => {
    const peeked = peekable(Promise.reject(new Error('derivation failed')));

    await settle();
    expect(peeked.ready()).toBe(true);
    await expect(peeked.promise).rejects.toThrow('derivation failed');
  });

  it('does not raise an unhandled rejection when nobody awaits it', async () => {
    peekable(Promise.reject(new Error('ignored')));
    await settle();
  });

  it('is ready for a promise that settled before it was wrapped', async () => {
    const already = Promise.resolve('early');
    await settle();

    const peeked = peekable(already);
    await settle();
    expect(peeked.ready()).toBe(true);
  });
});
