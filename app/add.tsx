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
  View,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { CameraView, useCameraPermissions, type BarcodeScanningResult } from 'expo-camera';
import * as Clipboard from 'expo-clipboard';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';

import { Field, FolderPicker, Input, SecretInput, SegmentedControl } from '@/components/form';
import { isValidSecret, normaliseSecret, parseOtpauthUri, type ParsedOtp } from '@/otp/otp';
import { useTheme } from '@/theme/theme_context';
import { useFolderSelection } from '@/vault/folder_selection';
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
  const { addEntry } = useVault();

  // The add menu on the home screen picks the starting mode. A successful scan
  // then moves to the form, so 'manual' is where every path ends up.
  const { mode: requestedMode } = useLocalSearchParams<{ mode?: string }>();
  const [mode, setMode] = useState<Mode>(requestedMode === 'manual' ? 'manual' : 'scan');
  const [form, setForm] = useState<FormState>(BLANK_FORM);
  const { pickerProps: folderPickerProps, saveWithFolder } = useFolderSelection(null);
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
      // The pending folder only becomes real now, and only if the code is
      // actually being filed into it.
      await saveWithFolder((folder_id) =>
        addEntry(
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
          folder_id,
        ),
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
      <Stack.Screen options={{ title: mode === 'scan' ? 'Scan QR code' : 'Enter code' }} />

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
              marginTop: spacing.lg,
              padding: spacing.md,
            },
          ]}
        >
          <Text style={{ color: colors.text, fontSize: 13, lineHeight: 18 }}>{notice}</Text>
          <Text style={{ color: colors.textFaint, fontSize: 11, marginTop: 4 }}>Tap to dismiss</Text>
        </Pressable>
      ) : null}

      {mode === 'scan' ? (
        <ScanPane
          onScanned={acceptUri}
          onPaste={pasteFromClipboard}
          onManual={() => setMode('manual')}
        />
      ) : (
        <ScrollView
          contentContainerStyle={{ padding: spacing.lg, gap: spacing.lg }}
          keyboardShouldPersistTaps="handled"
        >
          <Field label="Name" hint="For example, GitHub">
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
            <SecretInput
              value={form.secret}
              onChangeText={(v) => set('secret', v)}
              placeholder="JBSWY3DPEHPK3PXP"
              autoCapitalize="characters"
            />
          </Field>

          <Field label="Folder">
            <FolderPicker {...folderPickerProps} />
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

          <Pressable
            onPress={() => router.back()}
            disabled={saving}
            style={({ pressed }) => [
              styles.secondaryButton,
              {
                backgroundColor: pressed ? colors.surfaceAlt : 'transparent',
                borderColor: colors.border,
                borderRadius: radius.md,
              },
            ]}
            accessibilityRole="button"
            accessibilityLabel="Cancel"
          >
            <Text style={{ color: colors.textMuted, fontSize: 16, fontWeight: '500' }}>Cancel</Text>
          </Pressable>
        </ScrollView>
      )}
    </KeyboardAvoidingView>
  );
}

function ScanPane({
  onScanned,
  onPaste,
  onManual,
}: {
  onScanned: (data: string) => void;
  onPaste: () => void;
  onManual: () => void;
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
          You can enter the code by hand instead, or paste an otpauth:// link.
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
        <Pressable onPress={onManual} style={{ paddingVertical: spacing.sm }}>
          <Text style={{ color: colors.accent, fontSize: 15, fontWeight: '500' }}>
            Enter manually
          </Text>
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
        <View style={[styles.scanActions, { gap: spacing.sm }]}>
          <OverlayButton icon="clipboard-outline" label="Paste link" onPress={onPaste} />
          <OverlayButton icon="create-outline" label="Enter manually" onPress={onManual} />
        </View>
      </View>
    </View>
  );
}

/** A pill that has to stay legible over whatever the camera happens to see. */
function OverlayButton({
  icon,
  label,
  onPress,
}: {
  icon: React.ComponentProps<typeof Ionicons>['name'];
  label: string;
  onPress: () => void;
}) {
  const { colors, spacing, radius } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.overlayButton,
        {
          backgroundColor: pressed ? colors.accent : 'rgba(0, 0, 0, 0.62)',
          borderRadius: radius.pill,
          gap: spacing.sm,
        },
      ]}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <Ionicons name={icon} size={16} color="#FFFFFF" />
      <Text style={{ color: '#FFFFFF', fontSize: 14, fontWeight: '500' }}>{label}</Text>
    </Pressable>
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
    borderRadius: 16,
    overflow: 'hidden',
  },
  scanOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 24,
  },
  reticle: {
    width: '68%',
    aspectRatio: 1,
    borderWidth: 3,
  },
  scanActions: {
    alignItems: 'center',
  },
  overlayButton: {
    flexDirection: 'row',
    alignItems: 'center',
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
  secondaryButton: {
    paddingVertical: 15,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
  },
});
