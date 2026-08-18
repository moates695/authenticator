import { countdownFor, msToNextWindow, windowIndexFor } from './clock';

/**
 * An instant sitting exactly on a boundary for every period used below: it is a
 * whole multiple of 180 seconds, which 15, 30, 45, 60 and 90 all divide.
 */
const EPOCH = 1_700_000_100_000;

describe('windowIndexFor', () => {
  it('defaults to the 30-second window', () => {
    expect(windowIndexFor(EPOCH)).toBe(windowIndexFor(EPOCH, 30));
  });

  it('holds steady inside a window and steps at the boundary', () => {
    const start = windowIndexFor(EPOCH, 30);
    expect(windowIndexFor(EPOCH + 29_999, 30)).toBe(start);
    expect(windowIndexFor(EPOCH + 30_000, 30)).toBe(start + 1);
  });

  it('gives a short period more windows over the same span', () => {
    const spanned = (period: number) =>
      windowIndexFor(EPOCH + 60_000, period) - windowIndexFor(EPOCH, period);

    expect(spanned(15)).toBe(4);
    expect(spanned(30)).toBe(2);
    expect(spanned(60)).toBe(1);
  });

  it('rolls off-cadence periods on boundaries the 30-second window misses', () => {
    // Half way through a 30-second window a 15-second code has already rolled.
    expect(windowIndexFor(EPOCH + 15_000, 15)).toBe(windowIndexFor(EPOCH, 15) + 1);
    expect(windowIndexFor(EPOCH + 15_000, 30)).toBe(windowIndexFor(EPOCH, 30));
  });
});

describe('msToNextWindow', () => {
  it('returns a whole period when sitting exactly on a boundary', () => {
    expect(msToNextWindow(EPOCH, 30)).toBe(30_000);
  });

  it('counts down to the next boundary', () => {
    expect(msToNextWindow(EPOCH + 1_000, 30)).toBe(29_000);
    expect(msToNextWindow(EPOCH + 29_999, 30)).toBe(1);
  });

  it('lands on the boundary that changes the window index', () => {
    for (const period of [15, 30, 45, 60, 90]) {
      const now = EPOCH + 7_531;
      const at = now + msToNextWindow(now, period);

      expect(windowIndexFor(at, period)).toBe(windowIndexFor(now, period) + 1);
      // One millisecond short is still the window we started in.
      expect(windowIndexFor(at - 1, period)).toBe(windowIndexFor(now, period));
    }
  });

  it('never returns zero, so a timer built on it cannot spin', () => {
    for (const period of [1, 15, 30, 45]) {
      for (const offset of [0, 1, 999, 30_000, 123_456]) {
        expect(msToNextWindow(EPOCH + offset, period)).toBeGreaterThan(0);
      }
    }
  });

  it('treats a nonsense period as one second rather than dividing by zero', () => {
    expect(msToNextWindow(EPOCH, 0)).toBe(1_000);
    expect(Number.isFinite(msToNextWindow(EPOCH, -30))).toBe(true);
  });
});

describe('countdownFor', () => {
  it('reports a full period on the boundary and counts down within it', () => {
    expect(countdownFor(EPOCH, 30).secondsRemaining).toBe(30);
    expect(countdownFor(EPOCH + 1_000, 30).secondsRemaining).toBe(29);
    expect(countdownFor(EPOCH + 29_500, 30).secondsRemaining).toBe(1);
  });

  it('agrees with msToNextWindow on how much of the window is left', () => {
    for (const period of [15, 30, 60]) {
      const now = EPOCH + 4_250;
      expect(countdownFor(now, period).fractionRemaining).toBeCloseTo(
        msToNextWindow(now, period) / (period * 1000),
        10,
      );
    }
  });
});
