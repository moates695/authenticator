import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import {
  Keyboard,
  Platform,
  ScrollView,
  TextInput,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type ScrollViewProps,
} from 'react-native';

/**
 * How much of a view the keyboard is covering.
 *
 * `keyboardTop` is where the keyboard begins in window coordinates and
 * `viewBottom` is where the view ends in the same space, so this is what the two
 * actually did rather than what the platform is supposed to do. That matters:
 * Android may resize the window when the keyboard opens, which leaves the two
 * edges level and this at zero — the layout has already made room, and padding
 * it a second time would lift the form twice as far as the keyboard is tall.
 */
export function keyboardOverlap(viewBottom: number, keyboardTop: number | null): number {
  if (keyboardTop === null) return 0;
  return Math.max(0, viewBottom - keyboardTop);
}

/**
 * How far to scroll so a focused field clears the keyboard, with `gap` left
 * underneath it. Zero when the field is already clear, so a field near the top
 * of a form stays where it is instead of being dragged down to meet the
 * keyboard.
 */
export function shiftToReveal(inputBottom: number, visibleBottom: number, gap: number): number {
  return Math.max(0, inputBottom + gap - visibleBottom);
}

/** Space left between the bottom of a focused field and the top of the keyboard. */
const REVEAL_GAP = 24;

/**
 * Long enough for the padding below to land and the form to be laid out at its
 * new height. Measuring any sooner reads the position the field is leaving.
 */
const REVEAL_DELAY_MS = 60;

const SHOW_EVENT = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
const HIDE_EVENT = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';

function noop() {}

const RevealContext = createContext<() => void>(noop);

/**
 * Ask the enclosing `KeyboardAwareScrollView` to bring the focused field into
 * view. Outside one it does nothing, so form controls can call it from `onFocus`
 * without caring where they have been mounted.
 */
export function useKeyboardReveal(): () => void {
  return useContext(RevealContext);
}

/**
 * A `ScrollView` that keeps the focused field above the keyboard.
 *
 * `KeyboardAvoidingView` alone is not enough here. It shrinks the view, which
 * re-centres a short form and is all a short form needs, but it has no idea
 * which field is being typed into — on a taller form the field can end up under
 * the keyboard with no way to tell the scroll view about it. The two halves are
 * therefore: measure how much the keyboard really covers and take that off the
 * height, then scroll the focused field up out of what is left.
 *
 * Measuring rather than assuming is what makes one component work on both
 * platforms. iOS lays the keyboard over the app, so the overlap is its full
 * height; Android may resize the window instead, which leaves the overlap at
 * zero and nothing to do.
 */
export function KeyboardAwareScrollView({
  gap = REVEAL_GAP,
  onScroll,
  children,
  ...props
}: ScrollViewProps & { gap?: number }) {
  const scroller = useRef<ScrollView>(null);
  const container = useRef<View>(null);
  /** Window-space bottom edge of the scroll area, ignoring the keyboard. */
  const viewBottom = useRef(0);
  /** Where the keyboard starts, or null while it is down. */
  const keyboardTop = useRef<number | null>(null);
  const scrollY = useRef(0);
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [overlap, setOverlap] = useState(0);

  const measure = useCallback(() => {
    container.current?.measureInWindow((_x, y, _width, height) => {
      viewBottom.current = y + height;
      setOverlap(keyboardOverlap(viewBottom.current, keyboardTop.current));
    });
  }, []);

  const reveal = useCallback(() => {
    if (pending.current) clearTimeout(pending.current);
    pending.current = setTimeout(() => {
      pending.current = null;
      const input = TextInput.State.currentlyFocusedInput();
      const scroll = scroller.current;
      if (!input || !scroll) return;

      input.measureInWindow((_x, y, _width, height) => {
        const visibleBottom = Math.min(viewBottom.current, keyboardTop.current ?? Infinity);
        const shift = shiftToReveal(y + height, visibleBottom, gap);
        // A shift of a pixel or two is measurement noise, and scrolling for it
        // only makes the form twitch every time a field is tapped.
        if (shift > 1) scroll.scrollTo({ y: scrollY.current + shift, animated: true });
      });
    }, REVEAL_DELAY_MS);
  }, [gap]);

  useEffect(() => {
    const shown = Keyboard.addListener(SHOW_EVENT, (event) => {
      keyboardTop.current = event.endCoordinates.screenY;
      measure();
      reveal();
    });
    const hidden = Keyboard.addListener(HIDE_EVENT, () => {
      keyboardTop.current = null;
      setOverlap(0);
    });

    return () => {
      shown.remove();
      hidden.remove();
      if (pending.current) clearTimeout(pending.current);
    };
  }, [measure, reveal]);

  return (
    <View
      ref={container}
      // Measured on every layout, not just the first: on Android the window
      // resizing around the keyboard arrives as a layout change, and the overlap
      // has to be recomputed against where the view ended up.
      onLayout={measure}
      style={{ flex: 1, paddingBottom: overlap }}
    >
      <RevealContext.Provider value={reveal}>
        <ScrollView
          ref={scroller}
          keyboardShouldPersistTaps="handled"
          scrollEventThrottle={16}
          onScroll={(event: NativeSyntheticEvent<NativeScrollEvent>) => {
            scrollY.current = event.nativeEvent.contentOffset.y;
            onScroll?.(event);
          }}
          {...props}
        >
          {children}
        </ScrollView>
      </RevealContext.Provider>
    </View>
  );
}
