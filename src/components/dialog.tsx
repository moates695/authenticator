import { useEffect, useRef, useState } from 'react';
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { useTheme } from '@/theme/theme_context';

/**
 * The card every dialog in the app sits in: dimmed backdrop, centred surface,
 * dismissed by the back gesture or a tap outside. Used instead of `Alert` so
 * prompts carry the app's own palette and radii rather than the platform's.
 */
export function Dialog({
  visible,
  onDismiss,
  children,
}: {
  visible: boolean;
  onDismiss: () => void;
  children: React.ReactNode;
}) {
  const { colors, spacing, radius } = useTheme();

  return (
    // Not `statusBarTranslucent`: that makes the modal window ignore the soft
    // keyboard, leaving the card sitting behind it.
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onDismiss}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <Pressable
          onPress={onDismiss}
          style={{
            flex: 1,
            backgroundColor: colors.overlay,
            alignItems: 'center',
            justifyContent: 'center',
            padding: spacing.xl,
          }}
        >
          {/* Swallows taps so pressing inside the card does not dismiss it. */}
          <Pressable
            onPress={() => {}}
            style={{
              width: '100%',
              maxWidth: 360,
              gap: spacing.md,
              backgroundColor: colors.surface,
              borderRadius: radius.lg,
              padding: spacing.lg,
            }}
          >
            {children}
          </Pressable>
        </Pressable>
      </KeyboardAvoidingView>
    </Modal>
  );
}

export function DialogTitle({ children }: { children: React.ReactNode }) {
  const { colors } = useTheme();
  return <Text style={{ color: colors.text, fontSize: 16, fontWeight: '600' }}>{children}</Text>;
}

/** The row of text actions along the bottom of a dialog. */
function DialogActions({ children }: { children: React.ReactNode }) {
  const { spacing } = useTheme();
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'flex-end', gap: spacing.lg }}>
      {children}
    </View>
  );
}

function DialogAction({
  label,
  onPress,
  tone = 'muted',
  disabled,
}: {
  label: string;
  onPress: () => void;
  tone?: 'muted' | 'accent' | 'danger';
  disabled?: boolean;
}) {
  const { colors } = useTheme();
  const tint =
    tone === 'danger' ? colors.danger : tone === 'accent' ? colors.accent : colors.textMuted;

  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityState={{ disabled: !!disabled }}
    >
      <Text
        style={{
          color: disabled ? colors.textFaint : tint,
          fontSize: 15,
          fontWeight: tone === 'muted' ? '400' : '600',
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

/**
 * Asks for a single line of text — a folder name, say. `initialValue` seeds the
 * field, which is what turns this into a rename prompt as well as a new-name
 * one; it is applied each time the dialog opens.
 */
export function NameDialog({
  visible,
  title,
  placeholder,
  initialValue = '',
  confirmLabel,
  busy,
  onCancel,
  onConfirm,
}: {
  visible: boolean;
  title: string;
  placeholder?: string;
  initialValue?: string;
  confirmLabel: string;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: (name: string) => void;
}) {
  const { colors, spacing, radius } = useTheme();
  const [name, setName] = useState(initialValue);
  const inputRef = useRef<TextInput>(null);
  const trimmed = name.trim();

  // `autoFocus` is unreliable inside a Modal — the field mounts before the modal
  // window has taken focus, so on Android the caret lands but the keyboard never
  // comes up. Focusing once the fade has run raises it every time.
  //
  // Seeding here rather than on close means the text is not seen to clear while
  // the card is still fading out.
  useEffect(() => {
    if (!visible) return;
    setName(initialValue);
    const timer = setTimeout(() => inputRef.current?.focus(), 150);
    return () => clearTimeout(timer);
  }, [visible, initialValue]);

  const confirm = () => {
    if (!trimmed || busy) return;
    onConfirm(trimmed);
  };

  return (
    <Dialog visible={visible} onDismiss={onCancel}>
      <DialogTitle>{title}</DialogTitle>

      <TextInput
        ref={inputRef}
        value={name}
        onChangeText={setName}
        placeholder={placeholder}
        placeholderTextColor={colors.textFaint}
        onSubmitEditing={confirm}
        returnKeyType="done"
        maxLength={40}
        // A seeded name is usually being replaced wholesale, not edited.
        selectTextOnFocus
        accessibilityLabel={placeholder ?? title}
        style={{
          backgroundColor: colors.bg,
          borderColor: colors.border,
          borderWidth: StyleSheet.hairlineWidth,
          borderRadius: radius.md,
          paddingVertical: spacing.md,
          paddingHorizontal: spacing.md,
          color: colors.text,
          fontSize: 15,
        }}
      />

      <DialogActions>
        <DialogAction label="Cancel" onPress={onCancel} />
        <DialogAction
          label={confirmLabel}
          onPress={confirm}
          tone="accent"
          disabled={!trimmed || busy}
        />
      </DialogActions>
    </Dialog>
  );
}

/**
 * Confirms an action before it happens. `destructive` tints the confirm action
 * with the danger colour, which is what the platform alert used to convey.
 */
export function ConfirmDialog({
  visible,
  title,
  message,
  confirmLabel,
  cancelLabel = 'Cancel',
  destructive,
  onCancel,
  onConfirm,
}: {
  visible: boolean;
  title: string;
  message?: string;
  confirmLabel: string;
  cancelLabel?: string;
  destructive?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { colors } = useTheme();

  return (
    <Dialog visible={visible} onDismiss={onCancel}>
      <DialogTitle>{title}</DialogTitle>
      {message ? (
        <Text style={{ color: colors.textMuted, fontSize: 14, lineHeight: 20 }}>{message}</Text>
      ) : null}

      <DialogActions>
        <DialogAction label={cancelLabel} onPress={onCancel} />
        <DialogAction
          label={confirmLabel}
          onPress={onConfirm}
          tone={destructive ? 'danger' : 'accent'}
        />
      </DialogActions>
    </Dialog>
  );
}
