import { keyboardOverlap, shiftToReveal } from './keyboard';

describe('keyboardOverlap', () => {
  it('is zero while the keyboard is down', () => {
    expect(keyboardOverlap(800, null)).toBe(0);
  });

  it('is the part of the view the keyboard sits over', () => {
    expect(keyboardOverlap(800, 500)).toBe(300);
  });

  it('is zero when the layout already made room', () => {
    // Android resizing the window leaves the view ending exactly where the
    // keyboard starts. Padding again here would move the form up twice.
    expect(keyboardOverlap(500, 500)).toBe(0);
  });

  it('never goes negative when the view stops short of the keyboard', () => {
    expect(keyboardOverlap(420, 500)).toBe(0);
  });
});

describe('shiftToReveal', () => {
  const GAP = 24;

  it('leaves a field that is already clear where it is', () => {
    expect(shiftToReveal(300, 500, GAP)).toBe(0);
  });

  it('lifts a covered field far enough to clear the gap as well', () => {
    expect(shiftToReveal(520, 500, GAP)).toBe(44);
  });

  it('counts a field resting exactly on the keyboard as covered', () => {
    // Legible, but with the caret against the keyboard — worth the gap.
    expect(shiftToReveal(500, 500, GAP)).toBe(GAP);
  });

  it('asks for no shift with no gap and a field flush to the edge', () => {
    expect(shiftToReveal(500, 500, 0)).toBe(0);
  });
});
