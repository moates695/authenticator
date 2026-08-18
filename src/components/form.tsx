import { useRef, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { NameDialog } from '@/components/dialog';
import { useKeyboardReveal } from '@/components/keyboard';
import { useTheme } from '@/theme/theme_context';

/** A labelled form row, with an optional hint underneath the control. */
export function Field({
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

const MONO_FONT = Platform.OS === 'ios' ? 'Menlo' : 'monospace';

export function Input({
  monospace,
  onFocus,
  ...props
}: React.ComponentProps<typeof TextInput> & { monospace?: boolean }) {
  const { colors, spacing, radius } = useTheme();
  // No-op unless the form is inside a KeyboardAwareScrollView, which is where
  // the field being tapped is what decides how far the form moves.
  const reveal = useKeyboardReveal();

  return (
    <TextInput
      {...props}
      onFocus={(event) => {
        reveal();
        onFocus?.(event);
      }}
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
        fontFamily: monospace ? MONO_FONT : undefined,
      }}
    />
  );
}

/**
 * An input that masks its contents until the user asks to see them, with the
 * reveal toggle sitting inside the field on the right. Used for secret keys and
 * passphrases, which should not be readable over a shoulder while the rest of
 * the form is being filled in.
 *
 * `secret` names what is being hidden, for the toggle's accessibility label.
 */
export function SecretInput({
  secret = 'secret key',
  onFocus,
  ...props
}: React.ComponentProps<typeof TextInput> & { secret?: string }) {
  const { colors, spacing, radius } = useTheme();
  const reveal = useKeyboardReveal();
  const [visible, setVisible] = useState(false);

  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: colors.surface,
        borderColor: colors.border,
        borderWidth: StyleSheet.hairlineWidth,
        borderRadius: radius.md,
      }}
    >
      <TextInput
        {...props}
        onFocus={(event) => {
          reveal();
          onFocus?.(event);
        }}
        secureTextEntry={!visible}
        autoCorrect={false}
        spellCheck={false}
        placeholderTextColor={colors.textFaint}
        style={{
          flex: 1,
          paddingVertical: spacing.md,
          paddingLeft: spacing.md,
          color: colors.text,
          fontSize: 15,
          // Only while revealed: a custom typeface on a masked field drops the
          // masking on Android and shows the value in the clear, which for a
          // passphrase is the one thing this control exists to prevent.
          fontFamily: visible ? MONO_FONT : undefined,
        }}
      />
      <Pressable
        onPress={() => setVisible((prev) => !prev)}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel={visible ? `Hide ${secret}` : `Show ${secret}`}
        accessibilityState={{ selected: visible }}
        style={{ paddingHorizontal: spacing.md, paddingVertical: spacing.md }}
      >
        <Ionicons
          name={visible ? 'eye-off-outline' : 'eye-outline'}
          size={18}
          color={colors.textMuted}
        />
      </Pressable>
    </View>
  );
}

/**
 * A row of boxes for a fixed-length numeric code.
 *
 * One real text field, invisible and stretched across the whole row, with the
 * boxes drawn underneath it. Six separate inputs is the obvious build and the
 * wrong one: it fights the keyboard over backspace, breaks paste, and gives
 * autofill six targets when it is looking for one.
 *
 * `onComplete` fires once the last digit lands, so the common case needs no
 * button press.
 */
export function CodeInput({
  value,
  onChangeText,
  length,
  editable = true,
  autoFocus = false,
  onComplete,
}: {
  value: string;
  onChangeText: (value: string) => void;
  length: number;
  editable?: boolean;
  autoFocus?: boolean;
  onComplete?: (value: string) => void;
}) {
  const { colors, spacing, radius } = useTheme();
  const reveal = useKeyboardReveal();
  const input = useRef<TextInput>(null);
  const [focused, setFocused] = useState(false);

  const digits = [...Array(length).keys()];

  const change = (next: string) => {
    const digitsOnly = next.replace(/\D/g, '').slice(0, length);
    onChangeText(digitsOnly);
    if (digitsOnly.length === length) onComplete?.(digitsOnly);
  };

  return (
    <Pressable
      onPress={() => input.current?.focus()}
      accessibilityRole="none"
      style={{ flexDirection: 'row', gap: spacing.sm }}
    >
      {digits.map((index) => {
        // The cell the next digit will land in, so there is something to look
        // at on a screen with no visible caret.
        const active = focused && index === Math.min(value.length, length - 1);
        return (
          <View
            key={index}
            style={{
              flex: 1,
              aspectRatio: 0.78,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: colors.surface,
              borderColor: active ? colors.accent : colors.border,
              borderWidth: active ? 1.5 : StyleSheet.hairlineWidth,
              borderRadius: radius.md,
              opacity: editable ? 1 : 0.6,
            }}
          >
            <Text style={{ color: colors.text, fontSize: 22, fontWeight: '600' }}>
              {value[index] ?? ''}
            </Text>
          </View>
        );
      })}

      <TextInput
        ref={input}
        value={value}
        onChangeText={change}
        onFocus={() => {
          setFocused(true);
          reveal();
        }}
        onBlur={() => setFocused(false)}
        editable={editable}
        autoFocus={autoFocus}
        keyboardType="number-pad"
        inputMode="numeric"
        maxLength={length}
        caretHidden
        // iOS offers a code from Mail here; Android's is SMS-only and simply
        // never fires, which costs nothing.
        textContentType="oneTimeCode"
        autoComplete="one-time-code"
        accessibilityLabel="Verification code"
        style={[StyleSheet.absoluteFillObject, { opacity: 0 }]}
      />
    </Pressable>
  );
}

export function SegmentedControl<T extends string>({
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
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
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

/** Chip styling is shared by the folder options and the "New folder" affordance. */
function Chip({
  label,
  active,
  icon,
  onPress,
  onRemove,
  removeLabel,
}: {
  label: string;
  active?: boolean;
  icon?: React.ComponentProps<typeof Ionicons>['name'];
  onPress: () => void;
  /** Adds a trailing "x" inside the chip. Used for folders made in this form. */
  onRemove?: () => void;
  removeLabel?: string;
}) {
  const { colors, spacing, radius } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: !!active }}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.xs,
        backgroundColor: active ? colors.accent : colors.surface,
        borderColor: active ? colors.accent : colors.border,
        borderWidth: StyleSheet.hairlineWidth,
        borderRadius: radius.pill,
        paddingVertical: spacing.sm,
        paddingLeft: spacing.md,
        paddingRight: onRemove ? spacing.sm : spacing.md,
      }}
    >
      {icon ? (
        <Ionicons name={icon} size={13} color={active ? '#FFFFFF' : colors.accent} />
      ) : null}
      <Text
        style={{
          color: active ? '#FFFFFF' : colors.text,
          fontSize: 13,
          fontWeight: active ? '600' : '400',
        }}
      >
        {label}
      </Text>
      {onRemove ? (
        <Pressable
          onPress={onRemove}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={removeLabel ?? `Delete ${label}`}
          style={{ paddingLeft: 2 }}
        >
          <Ionicons
            name="close-circle"
            size={15}
            color={active ? 'rgba(255, 255, 255, 0.85)' : colors.textFaint}
          />
        </Pressable>
      ) : null}
    </Pressable>
  );
}

/**
 * Picks the folder an entry belongs to. Passing `onCreate` adds a "New folder"
 * chip that opens a name dialog; the created folder is selected straight away,
 * so filing a code into a folder that does not exist yet is one step.
 *
 * `canCreate` lets a caller cap how many folders one visit may add — the add
 * screen allows a single one per scan — and folders listed in `removableIds`
 * carry an "x" that hands them back through `onRemove`.
 */
export function FolderPicker({
  folders,
  selected,
  onSelect,
  onCreate,
  canCreate = true,
  removableIds,
  onRemove,
}: {
  folders: { id: string; name: string }[];
  selected: string | null;
  onSelect: (id: string | null) => void;
  onCreate?: (name: string) => Promise<{ id: string }>;
  canCreate?: boolean;
  removableIds?: readonly string[];
  onRemove?: (id: string) => void;
}) {
  const { spacing } = useTheme();
  const [creating, setCreating] = useState(false);
  /** Latched while the folder is being written, so a double tap cannot make two. */
  const [busy, setBusy] = useState(false);

  const options: { id: string | null; name: string }[] = [
    { id: null, name: 'No folder' },
    ...folders.map((f) => ({ id: f.id as string | null, name: f.name })),
  ];

  const create = async (name: string) => {
    if (!onCreate || busy) return;
    setBusy(true);
    try {
      const folder = await onCreate(name);
      onSelect(folder.id);
      setCreating(false);
    } catch {
      // The vault store surfaces write failures itself; closing the dialog would
      // just lose the name, so leave it open for another try.
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={{ gap: spacing.sm }}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm }}>
        {options.map((option) => (
          <Chip
            key={option.id ?? 'ungrouped'}
            label={option.name}
            active={option.id === selected}
            onPress={() => onSelect(option.id)}
            onRemove={
              option.id && onRemove && removableIds?.includes(option.id)
                ? () => onRemove(option.id as string)
                : undefined
            }
            removeLabel={`Delete folder ${option.name}`}
          />
        ))}
        {onCreate && canCreate ? (
          <Chip label="New folder" icon="add" onPress={() => setCreating(true)} />
        ) : null}
      </View>

      {onCreate ? (
        <NameDialog
          visible={creating}
          title="New folder"
          placeholder="Folder name"
          confirmLabel="Create"
          busy={busy}
          onCancel={() => setCreating(false)}
          onConfirm={(name) => void create(name)}
        />
      ) : null}
    </View>
  );
}
