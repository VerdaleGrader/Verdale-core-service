import SecretBox, { SecretBoxError } from '@/libs/crypto';

const OLD = 'old-key-secret-0123456789-0123456789-abcd';
const NEW = 'new-key-secret-0123456789-0123456789-abcd';

describe('SecretBox', () => {
  it('round-trips a secret and stores nothing readable', () => {
    const box = new SecretBox({ k1: OLD });
    const stored = box.encrypt('sk-ant-very-secret');
    expect(stored.keyId).toBe('k1');
    expect(stored.ciphertext.toString('utf8')).not.toContain('very-secret');
    expect(box.decrypt(stored)).toBe('sk-ant-very-secret');
  });

  it('uses a fresh nonce each time', () => {
    const box = new SecretBox({ k1: OLD });
    expect(box.encrypt('same').nonce.equals(box.encrypt('same').nonce)).toBe(false);
  });

  it('reads old secrets after a rotation and writes new ones with the first key', () => {
    const stored = new SecretBox({ old: OLD }).encrypt('value');
    const rotated = new SecretBox({ next: NEW, old: OLD });
    expect(rotated.decrypt(stored)).toBe('value');
    expect(rotated.encrypt('value').keyId).toBe('next');
  });

  it('refuses a secret whose key was removed, a tampered one, and a moved key id', () => {
    const box = new SecretBox({ k1: OLD, k2: NEW });
    const stored = box.encrypt('value');
    expect(() => new SecretBox({ k2: NEW }).decrypt(stored)).toThrow(SecretBoxError);
    const tampered = { ...stored, ciphertext: Buffer.from(stored.ciphertext) };
    tampered.ciphertext[0] = tampered.ciphertext[0]! ^ 1;
    expect(() => box.decrypt(tampered)).toThrow(SecretBoxError);
    expect(() => box.decrypt({ ...stored, keyId: 'k2' })).toThrow(SecretBoxError);
  });

  it('needs at least one key', () => {
    expect(() => new SecretBox({})).toThrow(SecretBoxError);
  });
});
