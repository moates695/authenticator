import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';

import { ConfirmDialog } from '@/components/dialog';
import { Field, FolderPicker, Input } from '@/components/form';
import { useTheme } from '@/theme/theme_context';
import { useFolderSelection } from '@/vault/folder_selection';
import { entryTitle, type Entry } from '@/vault/types';
import { useVault } from '@/vault/vault_store';

export default function EntrySettingsScreen() {
  const { colors, spacing } = useTheme();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { vault, loading } = useVault();

  const entry = vault.entries.find((e) => e.id === id);

  if (loading && !entry) {
    return (
      <View style={[styles.centre, { backgroundColor: colors.bg }]}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  if (!entry) {
    return (
      <View
        style={[
          styles.centre,
          { backgroundColor: colors.bg, paddingHorizontal: spacing.xl, gap: spacing.sm },
        ]}
      >
        <Stack.Screen options={{ title: 'Code settings' }} />
        <Text style={{ color: colors.text, fontSize: 16, fontWeight: '600' }}>
          This code is gone
        </Text>
        <Text style={{ color: colors.textMuted, fontSize: 14, textAlign: 'center', lineHeight: 20 }}>
          It was removed from the vault. Nothing to change here.
        </Text>
        <Pressable onPress={() => router.back()} style={{ paddingVertical: spacing.md }}>
          <Text style={{ color: colors.accent, fontSize: 15, fontWeight: '600' }}>Back to codes</Text>
        </Pressable>
      </View>
    );
  }

  // Remounting per entry keeps the form state and the entry it was seeded from
  // impossible to get out of step.
  return <EntrySettings key={entry.id} entry={entry} />;
}

function EntrySettings({ entry }: { entry: Entry }) {
  const { colors, spacing, radius } = useTheme();
  const router = useRouter();
  const { updateEntry, moveEntry, deleteEntry } = useVault();

  const [issuer, setIssuer] = useState(entry.issuer);
  const [account, setAccount] = useState(entry.account);
  const {
    selected: folderId,
    setSelected: setFolderId,
    pickerProps: folderPickerProps,
    saveWithFolder,
  } = useFolderSelection(entry.folder_id);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  // A move made elsewhere — deleting the folder this code sat in, say — should
  // not be silently reverted by a stale selection sitting in this form.
  useEffect(() => {
    setFolderId((current) => (current === entry.folder_id ? current : entry.folder_id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry.folder_id]);

  const dirty =
    issuer.trim() !== entry.issuer ||
    account.trim() !== entry.account ||
    folderId !== entry.folder_id;

  const save = async () => {
    if (!issuer.trim() && !account.trim()) {
      setNotice('Give the code a title so you can recognise it.');
      return;
    }

    setSaving(true);
    try {
      // A folder made in the picker is only written now, and only if the code
      // is really being filed into it.
      await saveWithFolder(async (folder_id) => {
        if (issuer.trim() !== entry.issuer || account.trim() !== entry.account) {
          await updateEntry(entry.id, { issuer: issuer.trim(), account: account.trim() });
        }
        if (folder_id !== entry.folder_id) {
          await moveEntry(entry.id, folder_id);
        }
      });
      setNotice(null);
      router.back();
    } catch (err) {
      setNotice(`Could not save: ${(err as Error).message}`);
    } finally {
      setSaving(false);
    }
  };

  const confirmDelete = () => {
    setConfirmingDelete(false);
    // Leave first: once the entry is gone this screen has nothing to show.
    router.back();
    void deleteEntry(entry.id).catch(() => {});
  };

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: colors.bg }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <Stack.Screen options={{ title: entryTitle(entry) }} />

      <ScrollView
        contentContainerStyle={{ padding: spacing.lg, gap: spacing.xl }}
        keyboardShouldPersistTaps="handled"
      >
        {notice ? (
          <Pressable
            onPress={() => setNotice(null)}
            style={{
              backgroundColor: colors.surface,
              borderColor: colors.warn,
              borderWidth: StyleSheet.hairlineWidth,
              borderRadius: radius.md,
              padding: spacing.md,
            }}
          >
            <Text style={{ color: colors.text, fontSize: 13, lineHeight: 18 }}>{notice}</Text>
            <Text style={{ color: colors.textFaint, fontSize: 11, marginTop: 4 }}>
              Tap to dismiss
            </Text>
          </Pressable>
        ) : null}

        <Section title="Name">
          <Field label="Title" hint="Shown in bold on the code's row">
            <Input
              value={issuer}
              onChangeText={setIssuer}
              placeholder="GitHub"
              autoCapitalize="words"
            />
          </Field>

          <Field label="Account" hint="Usually your email or username">
            <Input
              value={account}
              onChangeText={setAccount}
              placeholder="you@example.com"
              autoCapitalize="none"
              keyboardType="email-address"
            />
          </Field>
        </Section>

        <Section title="Folder">
          <FolderPicker {...folderPickerProps} />
        </Section>

        <Pressable
          onPress={save}
          disabled={!dirty || saving}
          style={({ pressed }) => [
            styles.primaryButton,
            {
              borderRadius: radius.md,
              backgroundColor: !dirty || saving
                ? colors.surfaceAlt
                : pressed
                  ? colors.accentSoft
                  : colors.accent,
            },
          ]}
          accessibilityRole="button"
          accessibilityLabel="Save changes"
          accessibilityState={{ disabled: !dirty || saving }}
        >
          {saving ? (
            <ActivityIndicator color={colors.text} />
          ) : (
            <Text
              style={[styles.primaryButtonLabel, { color: dirty ? '#FFFFFF' : colors.textFaint }]}
            >
              {dirty ? 'Save changes' : 'Saved'}
            </Text>
          )}
        </Pressable>

        <Section title="Details">
          <View style={{ borderRadius: radius.md, overflow: 'hidden' }}>
            <MetaRow
              label="Type"
              value={entry.type === 'hotp' ? 'Counter based (HOTP)' : 'Time based (TOTP)'}
            />
            <MetaRow label="Algorithm" value={entry.algorithm} />
            <MetaRow label="Digits" value={String(entry.digits)} />
            {entry.type === 'hotp' ? (
              <MetaRow label="Counter" value={String(entry.counter)} />
            ) : (
              <MetaRow label="Refreshes every" value={`${entry.period} seconds`} />
            )}
            <MetaRow label="Added" value={formatTimestamp(entry.created_at)} />
            <MetaRow label="Last changed" value={formatTimestamp(entry.updated_at)} />
            <MetaRow label="Identifier" value={entry.id} monospace last />
          </View>
          <Text style={{ color: colors.textFaint, fontSize: 12, lineHeight: 17 }}>
            The secret key itself is never shown. It stays encrypted on this device and is only
            decrypted to work out the current code.
          </Text>
        </Section>

        <Section title="Danger zone">
          <Pressable
            onPress={() => setConfirmingDelete(true)}
            style={({ pressed }) => ({
              alignItems: 'center',
              paddingVertical: spacing.md,
              borderRadius: radius.md,
              borderWidth: StyleSheet.hairlineWidth,
              borderColor: colors.danger,
              backgroundColor: pressed ? colors.surfaceAlt : 'transparent',
            })}
            accessibilityRole="button"
            accessibilityLabel={`Delete ${entryTitle(entry)}`}
          >
            <Text style={{ color: colors.danger, fontSize: 15, fontWeight: '600' }}>
              Delete this code
            </Text>
          </Pressable>
          <Text style={{ color: colors.textFaint, fontSize: 12, lineHeight: 17 }}>
            You will be asked to confirm. A deleted code cannot be recovered from this app.
          </Text>
        </Section>
      </ScrollView>

      <ConfirmDialog
        visible={confirmingDelete}
        title={`Remove ${entryTitle(entry)}?`}
        message="This deletes the code from this device. Make sure you can still sign in another way first."
        confirmLabel="Remove"
        destructive
        onCancel={() => setConfirmingDelete(false)}
        onConfirm={confirmDelete}
      />
    </KeyboardAvoidingView>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  const { colors, spacing } = useTheme();
  return (
    <View style={{ gap: spacing.md }}>
      <Text
        style={{ color: colors.textMuted, fontSize: 11, fontWeight: '700', letterSpacing: 0.8 }}
      >
        {title.toUpperCase()}
      </Text>
      {children}
    </View>
  );
}

function MetaRow({
  label,
  value,
  monospace,
  last,
}: {
  label: string;
  value: string;
  monospace?: boolean;
  last?: boolean;
}) {
  const { colors, spacing } = useTheme();
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: spacing.md,
        backgroundColor: colors.surface,
        paddingVertical: spacing.md,
        paddingHorizontal: spacing.md,
        borderBottomWidth: last ? 0 : StyleSheet.hairlineWidth,
        borderBottomColor: colors.border,
      }}
    >
      <Text style={{ color: colors.text, fontSize: 14 }}>{label}</Text>
      <Text
        style={{
          color: colors.textMuted,
          fontSize: monospace ? 11 : 14,
          flexShrink: 1,
          textAlign: 'right',
          fontFamily: monospace ? (Platform.OS === 'ios' ? 'Menlo' : 'monospace') : undefined,
        }}
        numberOfLines={monospace ? 2 : 1}
      >
        {value}
      </Text>
    </View>
  );
}

function formatTimestamp(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

const styles = StyleSheet.create({
  centre: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryButton: {
    paddingVertical: 15,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryButtonLabel: {
    fontSize: 16,
    fontWeight: '600',
  },
});
