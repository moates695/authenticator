import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { AppState } from 'react-native';

import { DEFAULT_PERIOD } from '@/vault/types';

/**
 * One ticker drives the whole app, exposed as two contexts:
 *
 *   TickContext    the current time in ms, refreshed a few times a second, for
 *                  the countdown ring's smooth sweep.
 *   WindowContext  the index of the current 30-second TOTP window. Because this
 *                  value only changes when codes actually change, code rows can
 *                  subscribe to it and re-render twice a minute instead of
 *                  several times a second.
 */
const TICK_INTERVAL_MS = 200;

const TickContext = createContext<number>(Date.now());
const WindowContext = createContext<number>(0);

export function windowIndexFor(nowMs: number, period = DEFAULT_PERIOD): number {
  return Math.floor(nowMs / 1000 / period);
}

/**
 * Milliseconds until the next window boundary for `period`. Windows are aligned
 * to the Unix epoch, not to when the app started, so this is plain modulo on the
 * absolute clock.
 */
export function msToNextWindow(nowMs: number, period = DEFAULT_PERIOD): number {
  const span = Math.max(1, period) * 1000;
  return span - (((nowMs % span) + span) % span);
}

/**
 * A guard so the timer never fires a hair *before* the boundary it was aimed at
 * and reads the window it was trying to leave.
 */
const BOUNDARY_GUARD_MS = 25;

export function ClockProvider({ children }: { children: ReactNode }) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;

    const start = () => {
      if (timer !== null) return;
      // Resync immediately: while backgrounded the clock has kept moving.
      setNow(Date.now());
      timer = setInterval(() => setNow(Date.now()), TICK_INTERVAL_MS);
    };

    const stop = () => {
      if (timer === null) return;
      clearInterval(timer);
      timer = null;
    };

    start();

    // No point burning battery on a countdown nobody can see.
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') start();
      else stop();
    });

    return () => {
      stop();
      subscription.remove();
    };
  }, []);

  return (
    <TickContext.Provider value={now}>
      <WindowContext.Provider value={windowIndexFor(now)}>{children}</WindowContext.Provider>
    </TickContext.Provider>
  );
}

/** Current time in ms. Changes several times a second — use sparingly. */
export function useTick(): number {
  return useContext(TickContext);
}

/** Changes once per 30-second window. Safe for code rows to depend on. */
export function useOtpWindow(): number {
  return useContext(WindowContext);
}

/**
 * The index of the current window for one entry's own period, changing exactly
 * when that entry's code does.
 *
 * An entry on a 15- or 45-second period rolls on boundaries the shared
 * 30-second window knows nothing about, so it runs its own timer, scheduled to
 * its next boundary rather than polling. Entries on the default period — which
 * is most of them, and every HOTP entry, whose period is unused — read the
 * shared window instead, so the common case still costs no timer at all.
 */
export function useWindowIndex(period: number): number {
  const shared = useOtpWindow();
  const onSharedCadence = period === DEFAULT_PERIOD;
  const [own, setOwn] = useState(() => windowIndexFor(Date.now(), period));

  // The shared window is also the resync pulse: it changes at least twice a
  // minute and immediately on return to the foreground, which re-runs this
  // effect and corrects a row whose timer was throttled while backgrounded.
  useEffect(() => {
    if (onSharedCadence) return;

    let timer: ReturnType<typeof setTimeout> | null = null;

    const settle = () => {
      const now = Date.now();
      setOwn(windowIndexFor(now, period));
      timer = setTimeout(settle, msToNextWindow(now, period) + BOUNDARY_GUARD_MS);
    };

    settle();

    return () => {
      if (timer !== null) clearTimeout(timer);
    };
  }, [period, onSharedCadence, shared]);

  return onSharedCadence ? shared : own;
}

export type Countdown = {
  /** Whole seconds left in the current window, 1..period. */
  secondsRemaining: number;
  /** Fraction of the window still remaining, 1 down to 0. */
  fractionRemaining: number;
};

export function countdownFor(nowMs: number, period = DEFAULT_PERIOD): Countdown {
  const elapsed = (nowMs / 1000) % period;
  const remaining = period - elapsed;
  return {
    secondsRemaining: Math.ceil(remaining),
    fractionRemaining: remaining / period,
  };
}
