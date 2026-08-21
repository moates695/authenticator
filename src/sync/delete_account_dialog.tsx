import { useEffect, useState } from 'react';
import { Text } from 'react-native';

import { Dialog, DialogAction, DialogActions, DialogTitle } from '@/components/dialog';
import { SecretInput } from '@/components/form';
import { useTheme } from '@/theme/theme_context';
import { useVault } from '@/vault/vault_store';
import { useAccount } from './account';

/**
 * The two steps a delete has to get through, in order. Split rather than
 * combined because they ask different things: the first asks whether the user
 * understands what is about to happen, the second asks them to prove they are
 * the one asking for it.
 *
 * A single dialog with a passphrase field in it would collapse those into one
 * press, which is exactly the press that should not be easy to make by accident.
 */
type Step = 'warning' | 'confirm';

/**
 * Closes the account for good, behind two confirmations.
 *
 * The passphrase in the second step is not decoration: the server refuses the
 * delete without the auth key derived from it, so a phone somebody picked up
 * unlocked cannot wipe the backup that the account exists to protect.
 */
export function DeleteAccountDialog({
  visible,
  onClose,
}: {
  visible: boolean;
  onClose: () => void;
}) {
  const { colors } = useTheme();
  const account = useAccount();
  const { vault } = useVault();

  const [step, setStep] = useState<Step>('warning');
  const [passphrase, setPassphrase] = useState('');

  // Every opening starts at the warning with an empty field, whatever the last
  // one ended on. Resetting on open rather than on close keeps the card from
  // being seen to change while it is still fading out.
  useEffect(() => {
    if (!visible) return;
    setStep('warning');
    setPassphrase('');
    account.clearError();
    // `clearError` is stable, and re-running this on an error being set would
    // wipe the message the second step is trying to show.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const close = () => {
    if (account.busy) return;
    account.clearError();
    onClose();
  };

  const confirm = async () => {
    if (!passphrase || account.busy) return;
    const deleted = await account.deleteAccount(passphrase);
    // On success the account gate takes the screen. The dialog is a native
    // window and would otherwise float above it, so it goes first.
    if (deleted) onClose();
  };

  const codes = vault.entries.length;
  const codeCount = codes === 1 ? '1 code' : `${codes} codes`;

  return (
    <Dialog visible={visible} onDismiss={close}>
      {step === 'warning' ? (
        <>
          <DialogTitle>Delete your account?</DialogTitle>
          <Text style={{ color: colors.textMuted, fontSize: 14, lineHeight: 20 }}>
            This erases your account and its encrypted backup from the server, and removes the{' '}
            {codeCount} on this device along with the key that opens them.
            {'\n\n'}
            It cannot be undone. Your recovery key will not bring any of it back, and neither can
            we — the backup is ciphertext nobody but you could read even while it existed.
          </Text>
          <DialogActions>
            <DialogAction label="Cancel" onPress={close} />
            <DialogAction label="Continue" onPress={() => setStep('confirm')} tone="danger" />
          </DialogActions>
        </>
      ) : (
        <>
          <DialogTitle>Confirm with your passphrase</DialogTitle>
          <Text style={{ color: colors.textMuted, fontSize: 14, lineHeight: 20 }}>
            Deleting {account.account?.email ?? 'this account'}. Everything described goes the
            moment you press Delete.
          </Text>

          <SecretInput
            secret="passphrase"
            value={passphrase}
            onChangeText={setPassphrase}
            placeholder="Your passphrase"
            autoCapitalize="none"
            autoComplete="current-password"
            textContentType="password"
            onSubmitEditing={() => void confirm()}
            returnKeyType="done"
            editable={!account.busy}
          />

          {account.error ? (
            <Text style={{ color: colors.danger, fontSize: 12, lineHeight: 18 }}>
              {account.error}
            </Text>
          ) : null}

          <DialogActions>
            <DialogAction label="Cancel" onPress={close} disabled={account.busy} />
            <DialogAction
              label={account.busy ? 'Deleting…' : 'Delete'}
              onPress={() => void confirm()}
              tone="danger"
              disabled={!passphrase || account.busy}
            />
          </DialogActions>
        </>
      )}
    </Dialog>
  );
}
