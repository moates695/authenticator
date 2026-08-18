import { useCallback, useEffect, useRef, useState } from 'react';
import * as SecureStore from 'expo-secure-store';

import { type Folder } from './types';

/**
 * Which groups on the home screen are collapsed. Stored as the collapsed set
 * rather than the expanded one so a folder is open unless the user has said
 * otherwise — including folders created on another device, or created before
 * this preference existed.
 *
 * This is a view preference, not vault data: it stays on the device and is
 * deliberately outside the synced, encrypted vault.
 */
const STORAGE_KEY = 'collapsed_folders';

/** Stands in for the implicit group holding entries that are in no folder. */
export const UNFILED_KEY = 'unfiled';

/** The persistence key for a group, which has no folder when it is the unfiled one. */
export function groupKey(folder: Folder | null): string {
  return folder?.id ?? UNFILED_KEY;
}

/** Reads back a stored set, treating anything unexpected as "nothing collapsed". */
export function parseCollapsed(raw: string | null): Set<string> {
  if (!raw) return new Set();
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((key): key is string => typeof key === 'string'));
  } catch {
    return new Set();
  }
}

export function serialiseCollapsed(collapsed: ReadonlySet<string>): string {
  return JSON.stringify([...collapsed]);
}

export function toggleCollapsed(collapsed: ReadonlySet<string>, key: string): Set<string> {
  const next = new Set(collapsed);
  if (!next.delete(key)) next.add(key);
  return next;
}

/**
 * Collapses the given groups. Returns the original set when they are all
 * already collapsed, so callers can skip a pointless write.
 */
export function collapseAll(
  collapsed: ReadonlySet<string>,
  keys: Iterable<string>,
): ReadonlySet<string> {
  const next = new Set(collapsed);
  for (const key of keys) next.add(key);
  return next.size === collapsed.size ? collapsed : next;
}

/**
 * Drops keys for folders that no longer exist, so deleting folders cannot grow
 * the stored value without bound. Returns the original set when there is
 * nothing to drop, so callers can skip a pointless write.
 */
export function pruneCollapsed(
  collapsed: ReadonlySet<string>,
  validKeys: ReadonlySet<string>,
): ReadonlySet<string> {
  const kept = [...collapsed].filter((key) => validKeys.has(key));
  return kept.length === collapsed.size ? collapsed : new Set(kept);
}

/** Folder ids plus the unfiled group, which exists whether or not it has entries. */
export function validGroupKeys(folders: readonly Folder[]): Set<string> {
  return new Set([UNFILED_KEY, ...folders.map((folder) => folder.id)]);
}

export type CollapsedFolders = {
  collapsed: ReadonlySet<string>;
  /**
   * False until the stored set has been read. The list waits on this, so
   * collapsed folders never flash open on the way in.
   */
  loaded: boolean;
  toggle: (key: string) => void;
  /** Collapses these groups; a no-op when they are all closed already. */
  close: (keys: Iterable<string>) => void;
  /** Forgets keys outside `validKeys`; a no-op when they are all still current. */
  retain: (validKeys: ReadonlySet<string>) => void;
};

export function useCollapsedFolders(): CollapsedFolders {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set<string>());
  const [loaded, setLoaded] = useState(false);

  /** Mirrors `collapsed` synchronously, since a toggle reads it to build the next set. */
  const current = useRef<ReadonlySet<string>>(collapsed);

  const publish = useCallback((next: ReadonlySet<string>) => {
    current.current = next;
    setCollapsed(next);
    // Losing this preference costs the user one tap, so a failed write is not
    // worth interrupting them over.
    void SecureStore.setItemAsync(STORAGE_KEY, serialiseCollapsed(next)).catch(() => {});
  }, []);

  useEffect(() => {
    let active = true;

    SecureStore.getItemAsync(STORAGE_KEY)
      .then((raw) => {
        if (!active) return;
        const stored = parseCollapsed(raw);
        current.current = stored;
        setCollapsed(stored);
      })
      .catch(() => {
        // An unreadable preference just means every folder starts open.
      })
      .finally(() => {
        if (active) setLoaded(true);
      });

    return () => {
      active = false;
    };
  }, []);

  const toggle = useCallback(
    (key: string) => {
      publish(toggleCollapsed(current.current, key));
    },
    [publish],
  );

  const close = useCallback(
    (keys: Iterable<string>) => {
      const next = collapseAll(current.current, keys);
      if (next !== current.current) publish(next);
    },
    [publish],
  );

  const retain = useCallback(
    (validKeys: ReadonlySet<string>) => {
      const next = pruneCollapsed(current.current, validKeys);
      if (next !== current.current) publish(next);
    },
    [publish],
  );

  return { collapsed, loaded, toggle, close, retain };
}
