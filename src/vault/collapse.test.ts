import {
  UNFILED_KEY,
  collapseAll,
  groupKey,
  parseCollapsed,
  pruneCollapsed,
  serialiseCollapsed,
  toggleCollapsed,
  validGroupKeys,
} from './collapse';
import { type Folder } from './types';

function folder(id: string): Folder {
  return { id, name: id, order: 0, updated_at: 0 };
}

describe('groupKey', () => {
  it('uses the folder id', () => {
    expect(groupKey(folder('work'))).toBe('work');
  });

  it('uses a fixed key for the unfiled group, which has no folder to name it', () => {
    expect(groupKey(null)).toBe(UNFILED_KEY);
  });
});

describe('parseCollapsed', () => {
  it('starts with everything open when nothing has been stored', () => {
    expect(parseCollapsed(null)).toEqual(new Set());
  });

  it('reads back what was written', () => {
    const collapsed = new Set(['a', 'b']);
    expect(parseCollapsed(serialiseCollapsed(collapsed))).toEqual(collapsed);
  });

  it('falls back to everything open on unreadable stored data', () => {
    expect(parseCollapsed('not json')).toEqual(new Set());
    expect(parseCollapsed('{"a":true}')).toEqual(new Set());
  });

  it('ignores non-string members rather than collapsing on a junk key', () => {
    expect(parseCollapsed('["a", 7, null]')).toEqual(new Set(['a']));
  });
});

describe('toggleCollapsed', () => {
  it('collapses a folder that was open', () => {
    expect(toggleCollapsed(new Set(), 'a')).toEqual(new Set(['a']));
  });

  it('opens a folder that was collapsed', () => {
    expect(toggleCollapsed(new Set(['a', 'b']), 'a')).toEqual(new Set(['b']));
  });

  it('leaves the other folders alone', () => {
    expect(toggleCollapsed(new Set(['b']), 'a')).toEqual(new Set(['b', 'a']));
  });

  it('does not mutate the set it was given', () => {
    const before = new Set(['a']);
    toggleCollapsed(before, 'b');
    expect(before).toEqual(new Set(['a']));
  });
});

describe('collapseAll', () => {
  it('collapses groups that were open', () => {
    expect(collapseAll(new Set(), ['a', 'b'])).toEqual(new Set(['a', 'b']));
  });

  it('leaves the groups it was not given alone', () => {
    expect(collapseAll(new Set(['a']), ['b'])).toEqual(new Set(['a', 'b']));
  });

  it('returns the same set when they are all collapsed already, so no write is needed', () => {
    const collapsed = new Set(['a', 'b']);
    expect(collapseAll(collapsed, ['a'])).toBe(collapsed);
    expect(collapseAll(collapsed, [])).toBe(collapsed);
  });

  it('does not mutate the set it was given', () => {
    const before = new Set(['a']);
    collapseAll(before, ['b']);
    expect(before).toEqual(new Set(['a']));
  });
});

describe('pruneCollapsed', () => {
  const valid = validGroupKeys([folder('a'), folder('b')]);

  it('drops keys for folders that no longer exist', () => {
    expect(pruneCollapsed(new Set(['a', 'gone']), valid)).toEqual(new Set(['a']));
  });

  it('keeps the unfiled group, which exists even with no entries in it', () => {
    expect(pruneCollapsed(new Set([UNFILED_KEY]), valid)).toEqual(new Set([UNFILED_KEY]));
  });

  it('returns the same set when there is nothing to drop, so no write is needed', () => {
    const collapsed = new Set(['a', 'b']);
    expect(pruneCollapsed(collapsed, valid)).toBe(collapsed);
  });
});
