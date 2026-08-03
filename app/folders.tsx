import { useState } from 'react';
import {
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { useTheme } from '@/theme/theme_context';
import { useVault } from '@/vault/vault_store';

export default function FoldersScreen() {
  const { colors, spacing, radius } = useTheme();
  const { vault, addFolder, renameFolder, deleteFolder } = useVault();

  const [newName, setNewName] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');

  const folders = [...vault.folders].sort((a, b) => a.order - b.order);

  const countIn = (folderId: string) =>
    vault.entries.filter((e) => e.folder_id === folderId).length;

  const create = async () => {
    const name = newName.trim();
    if (!name) return;
    setNewName('');
    await addFolder(name).catch(() => {});
  };

  const commitRename = async () => {
    if (!editingId) return;
    const name = editingName.trim();
    const id = editingId;
    setEditingId(null);
    if (name) await renameFolder(id, name).catch(() => {});
  };

  const confirmDelete = (id: string, name: string) => {
    const count = countIn(id);
    Alert.alert(
      `Delete "${name}"?`,
      count > 0
        ? `The ${count} code${count === 1 ? '' : 's'} inside will move to Ungrouped. No codes are deleted.`
        : 'This folder is empty.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete folder',
          style: 'destructive',
          onPress: () => {
            void deleteFolder(id).catch(() => {});
          },
        },
      ],
    );
  };

  return (
    <ScrollView
      style={{ backgroundColor: colors.bg }}
      contentContainerStyle={{ padding: spacing.lg, gap: spacing.lg }}
      keyboardShouldPersistTaps="handled"
    >
      <View style={{ gap: spacing.sm }}>
        <Text style={{ color: colors.text, fontSize: 13, fontWeight: '600' }}>New folder</Text>
        <View style={{ flexDirection: 'row', gap: spacing.sm }}>
          <TextInput
            value={newName}
            onChangeText={setNewName}
            placeholder="Work, Personal, Banking…"
            placeholderTextColor={colors.textFaint}
            onSubmitEditing={create}
            returnKeyType="done"
            style={{
              flex: 1,
              backgroundColor: colors.surface,
              borderColor: colors.border,
              borderWidth: StyleSheet.hairlineWidth,
              borderRadius: radius.md,
              paddingVertical: spacing.md,
              paddingHorizontal: spacing.md,
              color: colors.text,
              fontSize: 15,
            }}
          />
          <Pressable
            onPress={create}
            disabled={!newName.trim()}
            style={({ pressed }) => ({
              justifyContent: 'center',
              paddingHorizontal: spacing.lg,
              borderRadius: radius.md,
              backgroundColor: !newName.trim()
                ? colors.surfaceAlt
                : pressed
                  ? colors.accentSoft
                  : colors.accent,
            })}
          >
            <Text
              style={{
                color: newName.trim() ? '#FFFFFF' : colors.textFaint,
                fontWeight: '600',
                fontSize: 15,
              }}
            >
              Add
            </Text>
          </Pressable>
        </View>
        <Text style={{ color: colors.textFaint, fontSize: 12, lineHeight: 17 }}>
          Folders hold codes directly — they cannot contain other folders.
        </Text>
      </View>

      {folders.length === 0 ? (
        <Text style={{ color: colors.textMuted, fontSize: 14, textAlign: 'center', marginTop: 24 }}>
          No folders yet. Codes without a folder appear under Ungrouped.
        </Text>
      ) : (
        <View style={{ gap: spacing.sm }}>
          <Text style={{ color: colors.textMuted, fontSize: 11, fontWeight: '700', letterSpacing: 0.8 }}>
            YOUR FOLDERS
          </Text>
          {folders.map((folder) => {
            const editing = editingId === folder.id;
            const count = countIn(folder.id);

            return (
              <View
                key={folder.id}
                style={{
                  backgroundColor: colors.surface,
                  borderRadius: radius.md,
                  padding: spacing.md,
                  gap: spacing.sm,
                }}
              >
                {editing ? (
                  <View style={{ flexDirection: 'row', gap: spacing.sm, alignItems: 'center' }}>
                    <TextInput
                      value={editingName}
                      onChangeText={setEditingName}
                      onSubmitEditing={commitRename}
                      autoFocus
                      returnKeyType="done"
                      style={{
                        flex: 1,
                        backgroundColor: colors.surfaceAlt,
                        borderRadius: radius.sm,
                        paddingVertical: spacing.sm,
                        paddingHorizontal: spacing.md,
                        color: colors.text,
                        fontSize: 15,
                      }}
                    />
                    <Pressable onPress={commitRename} hitSlop={8}>
                      <Text style={{ color: colors.accent, fontSize: 14, fontWeight: '600' }}>
                        Save
                      </Text>
                    </Pressable>
                  </View>
                ) : (
                  <View style={styles.folderRow}>
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Text style={{ color: colors.text, fontSize: 16 }} numberOfLines={1}>
                        {folder.name}
                      </Text>
                      <Text style={{ color: colors.textFaint, fontSize: 12, marginTop: 2 }}>
                        {count} code{count === 1 ? '' : 's'}
                      </Text>
                    </View>
                    <View style={{ flexDirection: 'row', gap: spacing.lg }}>
                      <Pressable
                        onPress={() => {
                          setEditingId(folder.id);
                          setEditingName(folder.name);
                        }}
                        hitSlop={8}
                      >
                        <Text style={{ color: colors.accent, fontSize: 14 }}>Rename</Text>
                      </Pressable>
                      <Pressable onPress={() => confirmDelete(folder.id, folder.name)} hitSlop={8}>
                        <Text style={{ color: colors.danger, fontSize: 14 }}>Delete</Text>
                      </Pressable>
                    </View>
                  </View>
                )}
              </View>
            );
          })}
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  folderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
});
