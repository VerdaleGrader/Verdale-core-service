import type { AiProvider } from '../../generated/prisma/enums';
import { Db } from '@/repositories/db';

export interface AiCredentialData {
  key_ciphertext: Buffer;
  key_nonce: Buffer;
  key_tag: Buffer;
  key_id: string;
  last4: string;
}

export default class AiCredentialRepository {
  list(db: Db, userId: string) {
    return db.userAiCredential.findMany({
      where: { user_id: userId },
      orderBy: { provider: 'asc' },
    });
  }

  find(db: Db, userId: string, provider: AiProvider) {
    return db.userAiCredential.findUnique({
      where: { user_id_provider: { user_id: userId, provider } },
    });
  }

  upsert(db: Db, userId: string, provider: AiProvider, input: AiCredentialData) {
    // Prisma wants plain ArrayBuffer-backed bytes, not a Buffer that may sit on a shared one.
    const data = {
      key_ciphertext: new Uint8Array(input.key_ciphertext),
      key_nonce: new Uint8Array(input.key_nonce),
      key_tag: new Uint8Array(input.key_tag),
      key_id: input.key_id,
      last4: input.last4,
    };
    return db.userAiCredential.upsert({
      where: { user_id_provider: { user_id: userId, provider } },
      create: { user_id: userId, provider, ...data },
      update: data,
    });
  }

  async remove(db: Db, userId: string, provider: AiProvider): Promise<void> {
    await db.userAiCredential.deleteMany({ where: { user_id: userId, provider } });
  }
}
