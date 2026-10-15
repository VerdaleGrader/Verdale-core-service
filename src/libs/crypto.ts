import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

/** A secret as stored: nothing in it is readable without the keyring entry named by `keyId`. */
export interface EncryptedSecret {
  ciphertext: Buffer;
  nonce: Buffer;
  tag: Buffer;
  keyId: string;
}

export class SecretBoxError extends Error {}

const ALGORITHM = 'aes-256-gcm';
const NONCE_BYTES = 12;

/**
 * Encrypts small secrets at rest (the authors' AI provider keys, GRD-124) with
 * AES-256-GCM. The keyring maps a key id to a secret of at least 32 characters,
 * as `AI_KEY_ENCRYPTION_KEYS` does. New secrets use the first entry; older
 * ones stay readable as long as their key id is still in the list, so a key is
 * rotated by putting the new one first and removing the old one once nothing
 * uses it.
 */
export default class SecretBox {
  private readonly keys = new Map<string, Buffer>();
  private readonly activeKeyId: string;

  constructor(keyring: Record<string, string>) {
    const entries = Object.entries(keyring);
    if (entries.length === 0) throw new SecretBoxError('The keyring is empty.');
    for (const [keyId, secret] of entries) {
      this.keys.set(
        keyId,
        Buffer.from(hkdfSync('sha256', secret, 'verdale-secret-box', `key:${keyId}`, 32))
      );
    }
    this.activeKeyId = entries[0]![0];
  }

  encrypt(plaintext: string): EncryptedSecret {
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.keys.get(this.activeKeyId)!, nonce);
    // The key id is authenticated too, so a ciphertext cannot be moved under another key id.
    cipher.setAAD(Buffer.from(this.activeKeyId));
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return { ciphertext, nonce, tag: cipher.getAuthTag(), keyId: this.activeKeyId };
  }

  decrypt(secret: EncryptedSecret): string {
    const key = this.keys.get(secret.keyId);
    if (!key)
      throw new SecretBoxError('The key that encrypted this secret is no longer configured.');
    try {
      const decipher = createDecipheriv(ALGORITHM, key, secret.nonce);
      decipher.setAAD(Buffer.from(secret.keyId));
      decipher.setAuthTag(secret.tag);
      return Buffer.concat([decipher.update(secret.ciphertext), decipher.final()]).toString('utf8');
    } catch {
      // Never include the original error: it says nothing useful and must not carry bytes along.
      throw new SecretBoxError('The secret could not be decrypted.');
    }
  }
}
