import { useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import { CameraView, useCameraPermissions, type BarcodeScanningResult } from 'expo-camera';
import * as Clipboard from 'expo-clipboard';
import { useRouter } from 'expo-router';

import { isValidSecret, normaliseSecret, parseOtpauthUri, type ParsedOtp } from '@/otp/otp';
import { useTheme } from '@/theme/theme_context';
import {
  DEFAULT_ALGORITHM,
  DEFAULT_DIGITS,
  DEFAULT_PERIOD,
  type OtpAlgorithm,
  type OtpType,
} from '@/vault/types';
import { useVault } from '@/vault/vault_store';

type Mode = 'scan' | 'manual';

type FormState = {
  issuer: string;
  account: string;
  secret: string;
  type: OtpType;
  algorithm: OtpAlgorithm;
  digits: string;
  period: string;
  counter: string;
};

const BLANK_FORM: FormState = {
  issuer: '',
  account: '',
  secret: '',
  type: 'totp',
  algorithm: DEFAULT_ALGORITHM,
  digits: String(DEFAULT_DIGITS),
  period: String(DEFAULT_PERIOD),
  counter: '0',
};

function formFromParsed(parsed: ParsedOtp): FormState {
  return {
    issuer: parsed.issuer,
    account: parsed.account,
    secret: parsed.secret,
    type: parsed.type,
    algorithm: parsed.algorithm,
    digits: String(parsed.digits),
    period: String(parsed.period),
    counter: String(parsed.counter),
  };
}

export default function AddScreen() {
  const { colors, spacing, radius } = useTheme();
  const router = useRouter();
  const { vault, addEntry } = useVault();

  const [mode, setMode] = useState<Mode>('scan');
  const [form, setForm] = useState<FormState>(BLANK_FORM);
  const [folderId, setFolderId] = useState<string | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  /** Accepts a scanned or pasted string and moves to the manual form to confirm. */
  const acceptUri = (raw: string) => {
    const text = raw.trim();

    if (/^otpauth-migration:\/\//i.test(text)) {
      setNotice(
        'That is a Google Authenticator export containing several codes. Bulk import is not built yet — for now, add each code individually.',
      );
      return;
    }

    try {
      setForm(formFromParsed(parseOtpauthUri(text)));
      setNotice(null);
      setMode('manual');
    } catch (err) {
      setNotice((err as Error).message);
    }
  };

  const pasteFromClipboard = async () => {
    const text = await Clipboard.getStringAsync();
    if (!text.trim()) {
      setNotice('Clipboard is empty.');
      return;
    }
    acceptUri(text);
  };

  const save = async () => {
    const secret = normaliseSecret(form.secret);
    if (!isValidSecret(secret)) {
      setNotice('That secret is not valid base32. Check for typos or missing characters.');
      return;
    }
    if (!form.issuer.trim() && !form.account.trim()) {
      setNotice('Give the code a name so you can recognise it.');
      return;
    }

    const digits = Number.parseInt(form.digits, 10);
    const period = Number.parseInt(form.period, 10);
    const counter = Number.parseInt(form.counter, 10);

    setSaving(true);
    try {
      await addEntry(
        {
          issuer: form.issuer.trim(),
          account: form.account.trim(),
          secret,
          type: form.type,
          algorithm: form.algorithm,
          digits: Number.isFinite(digits) && digits >= 6 && digits <= 10 ? digits : DEFAULT_DIGITS,
          period: Number.isFinite(period) && period > 0 ? period : DEFAULT_PERIOD,
          counter: Number.isFinite(counter) && counter >= 0 ? counter : 0,
        },
        folderId,
      );
      router.back();
    } catch (err) {
      setNotice(`Could not save: ${(err as Error).message}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <KeyboardAvoidingView
      style={[styles.screen, { backgroundColor: colors.bg }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View style={{ padding: spacing.lg, paddingBottom: spacing.md }}>
        <SegmentedControl
          options={[
            { value: 'scan', label: 'Scan QR' },
            { value: 'manual', label: 'Enter manually' },
          ]}
          value={mode}
          onChange={setMode}
        />
      </View>

      {notice ? (
        <Pressable
          onPress={() => setNotice(null)}
          style={[
            styles.notice,
            {
              backgroundColor: colors.surface,
              borderColor: colors.warn,
              borderRadius: radius.md,
              marginHorizontal: spacing.lg,
              padding: spacing.md,
            },
          ]}
        >
          <Text style={{ color: colors.text, fontSize: 13, lineHeight: 18 }}>{notice}</Text>
          <Text style={{ color: colors.textFaint, fontSize: 11, marginTop: 4 }}>Tap to dismiss</Text>
        </Pressable>
      ) : null}

      {mode === 'scan' ? (
        <ScanPane onScanned={acceptUri} onPaste={pasteFromClipboard} />
      ) : (
        <ScrollView
          contentContainerStyle={{ padding: spacing.lg, paddingTop: 0, gap: spacing.lg }}
          keyboardShouldPersistTaps="handled"
        >
          <Field label="Service" hint="For example, GitHub">
            <Input
              value={form.issuer}
              onChangeText={(v) => set('issuer', v)}
              placeholder="GitHub"
              autoCapitalize="words"
            />
          </Field>

          <Field label="Account" hint="Usually your email or username">
            <Input
              value={form.account}
              onChangeText={(v) => set('account', v)}
              placeholder="you@example.com"
              autoCapitalize="none"
              keyboardType="email-address"
            />
          </Field>

          <Field label="Secret key" hint="The base32 key from the service">
            <Input
              value={form.secret}
              onChangeText={(v) => set('secret', v)}
              placeholder="JBSWY3DPEHPK3PXP"
              autoCapitalize="characters"
              autoCorrect={false}
              monospace
            />
          </Field>

          <Field label="Folder">
            <FolderPicker
              folders={vault.folders}
              selected={folderId}
              onSelect={setFolderId}
            />
          </Field>

          <View style={styles.advancedToggle}>
            <Text style={{ color: colors.text, fontSize: 15 }}>Advanced settings</Text>
            <Switch
              value={showAdvanced}
              onValueChange={setShowAdvanced}
              trackColor={{ true: colors.accent, false: colors.surfaceAlt }}
            />
          </View>

          {showAdvanced ? (
            <View style={{ gap: spacing.lg }}>
              <Field label="Type">
                <SegmentedControl
                  options={[
                    { value: 'totp', label: 'Time based' },
                    { value: 'hotp', label: 'Counter based' },
                  ]}
                  value={form.type}
                  onChange={(v) => set('type', v)}
                />
              </Field>

              <Field label="Algorithm">
                <SegmentedControl
                  options={[
                    { value: 'SHA1', label: 'SHA1' },
                    { value: 'SHA256', label: 'SHA256' },
                    { value: 'SHA512', label: 'SHA512' },
                  ]}
                  value={form.algorithm}
                  onChange={(v) => set('algorithm', v)}
                />
              </Field>

              <View style={{ flexDirection: 'row', gap: spacing.md }}>
                <View style={{ flex: 1 }}>
                  <Field label="Digits">
                    <Input
                      value={form.digits}
                      onChangeText={(v) => set('digits', v)}
                      keyboardType="number-pad"
                      monospace
                    />
                  </Field>
                </View>
                <View style={{ flex: 1 }}>
                  {form.type === 'totp' ? (
                    <Field label="Period (s)">
                      <Input
                        value={form.period}
                        onChangeText={(v) => set('period', v)}
                        keyboardType="number-pad"
                        monospace
                      />
                    </Field>
                  ) : (
                    <Field label="Counter">
                      <Input
                        value={form.counter}
                        onChangeText={(v) => set('counter', v)}
                        keyboardType="number-pad"
                        monospace
                      />
                    </Field>
                  )}
                </View>
              </View>

              {form.type === 'totp' && form.period !== String(DEFAULT_PERIOD) ? (
                <Text style={{ color: colors.textMuted, fontSize: 12, lineHeight: 17 }}>
                  The countdown at the top of the app tracks {DEFAULT_PERIOD}-second codes, so this
                  entry will show its own timer on its row.
                </Text>
              ) : null}
            </View>
          ) : null}

          <Pressable
            onPress={save}
            disabled={saving}
            style={({ pressed }) => [
              styles.primaryButton,
              {
                backgroundColor: saving ? colors.surfaceAlt : pressed ? colors.accentSoft : colors.accent,
                borderRadius: radius.md,
              },
            ]}
          >
            {saving ? (
              <ActivityIndicator color={colors.text} />
            ) : (
              <Text style={styles.primaryButtonLabel}>Save code</Text>
            )}
          </Pressable>
        </ScrollView>
      )}
    </KeyboardAvoidingView>
  );
}

function ScanPane({
  onScanned,
  onPaste,
}: {
  onScanned: (data: string) => void;
  onPaste: () => void;
}) {
  const { colors, spacing, radius } = useTheme();
  const [permission, requestPermission] = useCameraPermissions();
  // Latches after the first successful read so one QR cannot fire repeatedly.
  const [handled, setHandled] = useState(false);

  const handleBarcode = (result: BarcodeScanningResult) => {
    if (handled) return;
    setHandled(true);
    onScanned(result.data);
    // Allow another attempt if the parse was rejected and the user stays here.
    setTimeout(() => setHandled(false), 1500);
  };

  if (!permission) {
    return (
      <View style={styles.centre}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  if (!permission.granted) {
    return (
      <View style={[styles.centre, { paddingHorizontal: spacing.xl, gap: spacing.md }]}>
        <Text style={{ color: colors.text, fontSize: 16, textAlign: 'center' }}>
          Camera access is needed to scan QR codes.
        </Text>
        <Text style={{ color: colors.textMuted, fontSize: 13, textAlign: 'center', lineHeight: 19 }}>
          You can also switch to "Enter manually" and paste an otpauth:// link instead.
        </Text>
        <Pressable
          onPress={() => void requestPermission()}
          style={({ pressed }) => [
            styles.primaryButton,
            {
              backgroundColor: pressed ? colors.accentSoft : colors.accent,
              borderRadius: radius.md,
              alignSelf: 'stretch',
            },
          ]}
        >
          <Text style={styles.primaryButtonLabel}>Allow camera</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={styles.scanArea}>
      <CameraView
        style={StyleSheet.absoluteFill}
        facing="back"
        barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
        onBarcodeScanned={handleBarcode}
      />
      <View style={styles.scanOverlay} pointerEvents="box-none">
        <View style={[styles.reticle, { borderColor: colors.accent, borderRadius: radius.lg }]} />
        <Pressable
          onPress={onPaste}
          style={({ pressed }) => [
            styles.pasteButton,
            { backgroundColor: pressed ? colors.accent : colors.overlay, borderRadius: radius.pill },
          ]}
        >
          <Text style={{ color: '#FFFFFF', fontSize: 14, fontWeight: '500' }}>
            Paste link instead
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

function FolderPicker({
  folders,
  selected,
  onSelect,
}: {
  folders: { id: string; name: string }[];
  selected: string | null;
  onSelect: (id: string | null) => void;
}) {
  const { colors, spacing, radius } = useTheme();
  const options: { id: string | null; name: string }[] = [
    { id: null, name: 'Ungrouped' },
    ...folders.map((f) => ({ id: f.id as string | null, name: f.name })),
  ];

  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm }}>
      {options.map((option) => {
        const active = option.id === selected;
        return (
          <Pressable
            key={option.id ?? 'ungrouped'}
            onPress={() => onSelect(option.id)}
            style={{
              backgroundColor: active ? colors.accent : colors.surface,
              borderColor: active ? colors.accent : colors.border,
              borderWidth: StyleSheet.hairlineWidth,
              borderRadius: radius.pill,
              paddingVertical: spacing.sm,
              paddingHorizontal: spacing.md,
            }}
          >
            <Text
              style={{
                color: active ? '#FFFFFF' : colors.text,
                fontSize: 13,
                fontWeight: active ? '600' : '400',
              }}
            >
              {option.name}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
}) {
  const { colors, spacing, radius } = useTheme();
  return (
    <View
      style={{
        flexDirection: 'row',
        backgroundColor: colors.surfaceAlt,
        borderRadius: radius.md,
        padding: 3,
      }}
    >
      {options.map((option) => {
        const active = option.value === value;
        return (
          <Pressable
            key={option.value}
            onPress={() => onChange(option.value)}
            style={{
              flex: 1,
              alignItems: 'center',
              paddingVertical: spacing.sm,
              borderRadius: radius.sm,
              backgroundColor: active ? colors.surface : 'transparent',
            }}
          >
            <Text
              style={{
                color: active ? colors.text : colors.textMuted,
                fontSize: 13,
                fontWeight: active ? '600' : '400',
              }}
            >
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  const { colors, spacing } = useTheme();
  return (
    <View style={{ gap: spacing.sm }}>
      <Text style={{ color: colors.text, fontSize: 13, fontWeight: '600' }}>{label}</Text>
      {children}
      {hint ? <Text style={{ color: colors.textFaint, fontSize: 12 }}>{hint}</Text> : null}
    </View>
  );
}

function Input({
  monospace,
  ...props
}: React.ComponentProps<typeof TextInput> & { monospace?: boolean }) {
  const { colors, spacing, radius } = useTheme();
  return (
    <TextInput
      {...props}
      placeholderTextColor={colors.textFaint}
      style={{
        backgroundColor: colors.surface,
        borderColor: colors.border,
        borderWidth: StyleSheet.hairlineWidth,
        borderRadius: radius.md,
        paddingVertical: spacing.md,
        paddingHorizontal: spacing.md,
        color: colors.text,
        fontSize: 15,
        fontFamily: monospace ? (Platform.OS === 'ios' ? 'Menlo' : 'monospace') : undefined,
      }}
    />
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
  },
  centre: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  notice: {
    borderWidth: StyleSheet.hairlineWidth,
    marginBottom: 12,
  },
  advancedToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  scanArea: {
    flex: 1,
    margin: 16,
    marginTop: 0,
    borderRadius: 16,
    overflow: 'hidden',
  },
  scanOverlay: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 24,
  },
  reticle: {
    width: '68%',
    aspectRatio: 1,
    borderWidth: 3,
  },
  pasteButton: {
    paddingVertical: 10,
    paddingHorizontal: 18,
  },
  primaryButton: {
    paddingVertical: 15,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryButtonLabel: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '600',
  },
});
