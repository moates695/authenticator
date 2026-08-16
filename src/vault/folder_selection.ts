import { useState } from 'react';

import { useVault } from './vault_store';

/**
 * Stands in for the not-yet-created folder while it is only a name in a form's
 * state. It never reaches the vault: `saveWithFolder` swaps it for the real id.
 */
export const PENDING_FOLDER_ID = 'pending-new-folder';

/**
 * Folder selection for a form whose code has not been filed yet.
 *
 * A folder made from the picker is held here as a name only. It becomes real
 * when — and only when — the form is saved with the code actually assigned to
 * it, so backing out, or picking a different folder before saving, leaves no
 * empty folder behind. At most one may be made per visit; existing folders are
 * managed on their own screen.
 */
export function useFolderSelection(current: string | null) {
  const { vault, addFolder, deleteFolder } = useVault();
  const [selected, setSelected] = useState<string | null>(current);
  const [pending, setPending] = useState<string | null>(null);

  /**
   * Drops the pending folder. The selection falls back to where the code sits
   * now — no folder at all when it is being added rather than edited.
   */
  const removePending = () => {
    setPending(null);
    setSelected((prev) => (prev === PENDING_FOLDER_ID ? current : prev));
  };

  /** Spread straight onto a `FolderPicker`. */
  const pickerProps = {
    folders:
      pending === null
        ? vault.folders
        : [...vault.folders, { id: PENDING_FOLDER_ID, name: pending }],
    selected,
    onSelect: setSelected,
    onCreate: async (name: string) => {
      setPending(name);
      return { id: PENDING_FOLDER_ID };
    },
    canCreate: pending === null,
    removableIds: [PENDING_FOLDER_ID] as const,
    onRemove: removePending,
  };

  /**
   * Runs `write` with the folder the code should end up in, creating the
   * pending folder first if that is where it is going. A failed write takes the
   * folder back out again: the code is what the user came here for, and a
   * folder made moments ago and now empty is just debris.
   */
  const saveWithFolder = async (write: (folder_id: string | null) => Promise<unknown>) => {
    if (selected !== PENDING_FOLDER_ID || pending === null) {
      await write(selected === PENDING_FOLDER_ID ? null : selected);
      return;
    }

    const created = await addFolder(pending);
    try {
      await write(created.id);
    } catch (err) {
      await deleteFolder(created.id).catch(() => {});
      throw err;
    }
  };

  return { selected, setSelected, pickerProps, saveWithFolder };
}
