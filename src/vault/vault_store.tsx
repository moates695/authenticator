import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import { entryFromParsed, newId, type ParsedOtp } from '@/otp/otp';
import { readVault, writeVault } from './vault_crypto';
import { emptyVault, type Entry, type Folder, type Tombstone, type Vault } from './types';

type VaultContextValue = {
  vault: Vault;
  loading: boolean;
  /** Set when the vault could not be read or written; surfaced to the user. */
  error: string | null;
  addEntry: (parsed: ParsedOtp, folder_id: string | null) => Promise<Entry>;
  updateEntry: (id: string, patch: Partial<Omit<Entry, 'id'>>) => Promise<void>;
  deleteEntry: (id: string) => Promise<void>;
  advanceCounter: (id: string) => Promise<void>;
  addFolder: (name: string) => Promise<Folder>;
  renameFolder: (id: string, name: string) => Promise<void>;
  /** Entries in the folder are moved to the top level rather than deleted. */
  deleteFolder: (id: string) => Promise<void>;
  reload: () => Promise<void>;
};

const VaultContext = createContext<VaultContextValue | null>(null);

function tombstone(id: string, kind: Tombstone['kind']): Tombstone {
  return { id, kind, deleted_at: Date.now() };
}

function nextOrder(items: { order: number }[]): number {
  return items.reduce((max, item) => Math.max(max, item.order), -1) + 1;
}

export function VaultProvider({ children }: { children: ReactNode }) {
  const [vault, setVault] = useState<Vault>(emptyVault);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  /**
   * The authoritative in-memory vault. React state lags a `setVault` call by a
   * render, so mutations read and write this synchronously and mirror it into
   * state for the UI.
   */
  const current = useRef<Vault>(vault);
  /** Serialises writes so two quick mutations cannot interleave on the file. */
  const writeChain = useRef<Promise<void>>(Promise.resolve());

  const publish = useCallback((next: Vault) => {
    current.current = next;
    setVault(next);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      publish(await readVault());
      setError(null);
    } catch (err) {
      setError(`Could not open your vault: ${(err as Error).message}`);
    } finally {
      setLoading(false);
    }
  }, [publish]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Applies `mutate`, shows the result immediately, then persists. If the write
   * fails the vault is re-read from disk so the screen never disagrees with
   * what was actually stored.
   */
  const commit = useCallback(
    (mutate: (vault: Vault) => Vault): Promise<void> => {
      const next: Vault = { ...mutate(current.current), updated_at: Date.now() };
      publish(next);

      const write = writeChain.current.then(async () => {
        try {
          await writeVault(next);
          setError(null);
        } catch (err) {
          setError(`Could not save: ${(err as Error).message}`);
          await load();
          throw err;
        }
      });

      // Swallow here so a failed write does not poison later ones.
      writeChain.current = write.catch(() => {});
      return write;
    },
    [publish, load],
  );

  const value = useMemo<VaultContextValue>(
    () => ({
      vault,
      loading,
      error,

      addEntry: async (parsed, folder_id) => {
        const siblings = current.current.entries.filter((e) => e.folder_id === folder_id);
        const entry = entryFromParsed(parsed, folder_id, nextOrder(siblings));
        await commit((v) => ({ ...v, entries: [...v.entries, entry] }));
        return entry;
      },

      updateEntry: (id, patch) =>
        commit((v) => ({
          ...v,
          entries: v.entries.map((e) =>
            e.id === id ? { ...e, ...patch, id: e.id, updated_at: Date.now() } : e,
          ),
        })),

      deleteEntry: (id) =>
        commit((v) => ({
          ...v,
          entries: v.entries.filter((e) => e.id !== id),
          tombstones: [...v.tombstones, tombstone(id, 'entry')],
        })),

      advanceCounter: (id) =>
        commit((v) => ({
          ...v,
          entries: v.entries.map((e) =>
            e.id === id ? { ...e, counter: e.counter + 1, updated_at: Date.now() } : e,
          ),
        })),

      addFolder: async (name) => {
        const folder: Folder = {
          id: newId(),
          name: name.trim(),
          order: nextOrder(current.current.folders),
          updated_at: Date.now(),
        };
        await commit((v) => ({ ...v, folders: [...v.folders, folder] }));
        return folder;
      },

      renameFolder: (id, name) =>
        commit((v) => ({
          ...v,
          folders: v.folders.map((f) =>
            f.id === id ? { ...f, name: name.trim(), updated_at: Date.now() } : f,
          ),
        })),

      deleteFolder: (id) =>
        commit((v) => ({
          ...v,
          folders: v.folders.filter((f) => f.id !== id),
          entries: v.entries.map((e) =>
            e.folder_id === id ? { ...e, folder_id: null, updated_at: Date.now() } : e,
          ),
          tombstones: [...v.tombstones, tombstone(id, 'folder')],
        })),

      reload: load,
    }),
    [vault, loading, error, commit, load],
  );

  return <VaultContext.Provider value={value}>{children}</VaultContext.Provider>;
}

export function useVault(): VaultContextValue {
  const ctx = useContext(VaultContext);
  if (!ctx) throw new Error('useVault must be used inside a VaultProvider');
  return ctx;
}

export type EntryGroup = {
  /** null for the implicit top-level group holding unfiled entries. */
  folder: Folder | null;
  entries: Entry[];
};

/** Orders folders, then entries within each, with unfiled entries last. */
export function groupEntries(vault: Vault): EntryGroup[] {
  const byOrder = <T extends { order: number }>(a: T, b: T) => a.order - b.order;

  const groups: EntryGroup[] = [...vault.folders].sort(byOrder).map((folder) => ({
    folder,
    entries: vault.entries.filter((e) => e.folder_id === folder.id).sort(byOrder),
  }));

  const unfiled = vault.entries.filter((e) => e.folder_id === null).sort(byOrder);
  if (unfiled.length > 0) groups.push({ folder: null, entries: unfiled });

  return groups;
}
