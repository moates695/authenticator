import { emptyVault, entrySubtitle, entryTitle, type Entry, type Folder, type Vault } from './types';
import { groupEntries, moveEntryToFolder } from './vault_store';

function entry(overrides: Partial<Entry>): Entry {
  return {
    id: 'e',
    folder_id: null,
    issuer: 'Example',
    account: 'user@example.com',
    secret: 'JBSWY3DPEHPK3PXP',
    type: 'totp',
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    counter: 0,
    order: 0,
    created_at: 0,
    updated_at: 0,
    ...overrides,
  };
}

function folder(id: string, name: string, order: number): Folder {
  return { id, name, order, updated_at: 0 };
}

function vaultWith(folders: Folder[], entries: Entry[]): Vault {
  return { ...emptyVault(), folders, entries };
}

describe('groupEntries', () => {
  it('returns nothing for an empty vault', () => {
    expect(groupEntries(emptyVault())).toEqual([]);
  });

  it('orders folders by their order field, not insertion order', () => {
    const vault = vaultWith(
      [folder('b', 'Banking', 1), folder('a', 'Work', 0)],
      [entry({ id: '1', folder_id: 'a' }), entry({ id: '2', folder_id: 'b' })],
    );
    expect(groupEntries(vault).map((g) => g.folder?.name)).toEqual(['Work', 'Banking']);
  });

  it('orders entries within a folder by their order field', () => {
    const vault = vaultWith(
      [folder('a', 'Work', 0)],
      [
        entry({ id: 'second', folder_id: 'a', order: 1 }),
        entry({ id: 'first', folder_id: 'a', order: 0 }),
      ],
    );
    expect(groupEntries(vault)[0].entries.map((e) => e.id)).toEqual(['first', 'second']);
  });

  it('places unfiled entries in a trailing group with no folder', () => {
    const vault = vaultWith(
      [folder('a', 'Work', 0)],
      [entry({ id: 'filed', folder_id: 'a' }), entry({ id: 'loose', folder_id: null })],
    );
    const groups = groupEntries(vault);

    expect(groups).toHaveLength(2);
    expect(groups[1].folder).toBeNull();
    expect(groups[1].entries.map((e) => e.id)).toEqual(['loose']);
  });

  it('omits the unfiled group entirely when every entry has a folder', () => {
    const vault = vaultWith([folder('a', 'Work', 0)], [entry({ folder_id: 'a' })]);
    expect(groupEntries(vault).some((g) => g.folder === null)).toBe(false);
  });

  it('keeps empty folders visible so they can be filled', () => {
    const vault = vaultWith([folder('a', 'Work', 0)], []);
    const groups = groupEntries(vault);
    expect(groups).toHaveLength(1);
    expect(groups[0].entries).toEqual([]);
  });

  it('shows entries pointing at a folder that no longer exists in the top-level group', () => {
    // deleteFolder reassigns its entries, but a folder deletion merged in from
    // another device may not — the entry must fall back to the top level
    // rather than silently disappear.
    const vault = vaultWith([folder('a', 'Work', 0)], [entry({ id: 'orphan', folder_id: 'gone' })]);
    const groups = groupEntries(vault);
    const topLevel = groups.find((g) => g.folder === null);
    expect(topLevel?.entries.map((e) => e.id)).toEqual(['orphan']);
  });
});

describe('moveEntryToFolder', () => {
  const found = (vault: Vault, id: string) => vault.entries.find((e) => e.id === id)!;

  it('files an unfiled entry into a folder', () => {
    const vault = vaultWith([folder('a', 'Work', 0)], [entry({ id: 'x', folder_id: null })]);
    expect(found(moveEntryToFolder(vault, 'x', 'a'), 'x').folder_id).toBe('a');
  });

  it('sends an entry back to the top level', () => {
    const vault = vaultWith([folder('a', 'Work', 0)], [entry({ id: 'x', folder_id: 'a' })]);
    expect(found(moveEntryToFolder(vault, 'x', null), 'x').folder_id).toBeNull();
  });

  it('places the moved entry last in its new folder', () => {
    const vault = vaultWith(
      [folder('a', 'Work', 0)],
      [
        entry({ id: 'first', folder_id: 'a', order: 0 }),
        entry({ id: 'second', folder_id: 'a', order: 1 }),
        entry({ id: 'incoming', folder_id: null, order: 0 }),
      ],
    );
    const moved = moveEntryToFolder(vault, 'incoming', 'a');

    expect(found(moved, 'incoming').order).toBe(2);
    expect(groupEntries(moved)[0].entries.map((e) => e.id)).toEqual([
      'first',
      'second',
      'incoming',
    ]);
  });

  it('does not reuse an order already taken in the destination', () => {
    // The entry arrives with order 0, which the destination is already using.
    const vault = vaultWith(
      [folder('a', 'Work', 0), folder('b', 'Personal', 1)],
      [
        entry({ id: 'sitting', folder_id: 'b', order: 0 }),
        entry({ id: 'incoming', folder_id: 'a', order: 0 }),
      ],
    );
    const moved = moveEntryToFolder(vault, 'incoming', 'b');
    expect(found(moved, 'incoming').order).not.toBe(found(moved, 'sitting').order);
  });

  it('leaves the vault untouched when the entry is already in that folder', () => {
    const vault = vaultWith([folder('a', 'Work', 0)], [entry({ id: 'x', folder_id: 'a', order: 3 })]);
    const moved = moveEntryToFolder(vault, 'x', 'a');

    // Identity, not just equality: a no-op move must not bump updated_at and
    // shuffle the entry to the bottom of the folder.
    expect(moved).toBe(vault);
    expect(found(moved, 'x').order).toBe(3);
  });

  it('leaves the vault untouched when the entry does not exist', () => {
    const vault = vaultWith([folder('a', 'Work', 0)], [entry({ id: 'x' })]);
    expect(moveEntryToFolder(vault, 'gone', 'a')).toBe(vault);
  });

  it('does not disturb the other entries', () => {
    const vault = vaultWith(
      [folder('a', 'Work', 0)],
      [entry({ id: 'x', folder_id: null, order: 0 }), entry({ id: 'y', folder_id: null, order: 1 })],
    );
    const moved = moveEntryToFolder(vault, 'x', 'a');

    expect(found(moved, 'y')).toEqual(found(vault, 'y'));
  });
});

describe('entry labelling', () => {
  it('uses the issuer as the title and the account beneath it', () => {
    const e = entry({ issuer: 'GitHub', account: 'me@example.com' });
    expect(entryTitle(e)).toBe('GitHub');
    expect(entrySubtitle(e)).toBe('me@example.com');
  });

  it('promotes the account to the title when there is no issuer', () => {
    const e = entry({ issuer: '', account: 'me@example.com' });
    expect(entryTitle(e)).toBe('me@example.com');
    expect(entrySubtitle(e)).toBe('');
  });

  it('falls back to a placeholder when both are blank', () => {
    expect(entryTitle(entry({ issuer: '  ', account: '' }))).toBe('Unnamed');
  });
});
