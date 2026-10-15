import type { AiProvider, User } from '../../../generated/prisma/client';
import { AI_TEST_LIMITS } from '@/constants/limits';
import { ConflictError, ServiceUnavailableError, ValidationError } from '@/errors';
import SecretBox, { SecretBoxError } from '@/libs/crypto';
import TLogger, { Layer } from '@/logging/logger';
import AiCredentialRepository from '@/repositories/ai-credential.repository';
import type { PrismaClient } from '../../../generated/prisma/client';

export interface AiCredentialDto {
  provider: AiProvider;
  /** The only part of the key ever shown back. */
  last4: string;
}

/**
 * The authors' own AI provider keys (GRD-124). A key is encrypted before it is
 * stored, returned only as its last four characters, and decrypted only inside
 * Core when a generation job starts. It is never logged.
 */
export default class AiCredentialService {
  private readonly logger = new TLogger(Layer.SERVICE);

  constructor(
    private readonly prisma: PrismaClient,
    private readonly credentials: AiCredentialRepository,
    /** Absent when AI_KEY_ENCRYPTION_KEYS is not set: the feature is off. */
    private readonly secretBox: SecretBox | undefined
  ) {}

  get enabled(): boolean {
    return this.secretBox !== undefined;
  }

  async list(user: User): Promise<AiCredentialDto[]> {
    const rows = await this.credentials.list(this.prisma, user.id);
    return rows.map((row) => ({ provider: row.provider, last4: row.last4 }));
  }

  async save(
    user: User,
    provider: AiProvider,
    apiKey: string,
    requestId: string
  ): Promise<AiCredentialDto> {
    const box = this.requireBox();
    const key = apiKey.trim();
    if (
      key.length < AI_TEST_LIMITS.key_min_length ||
      key.length > AI_TEST_LIMITS.key_max_length ||
      /\s/.test(key)
    ) {
      throw new ValidationError([
        { field: 'api_key', message: 'Paste the API key exactly as the provider shows it.' },
      ]);
    }
    const sealed = box.encrypt(key);
    const row = await this.credentials.upsert(this.prisma, user.id, provider, {
      key_ciphertext: sealed.ciphertext,
      key_nonce: sealed.nonce,
      key_tag: sealed.tag,
      key_id: sealed.keyId,
      last4: key.slice(-4),
    });
    this.logger
      .setContext('service.aiCredential.save', requestId)
      .info({ message: 'AI key saved', data: { userId: user.id, provider } });
    return { provider: row.provider, last4: row.last4 };
  }

  async remove(user: User, provider: AiProvider, requestId: string): Promise<void> {
    await this.credentials.remove(this.prisma, user.id, provider);
    this.logger
      .setContext('service.aiCredential.remove', requestId)
      .info({ message: 'AI key removed', data: { userId: user.id, provider } });
  }

  /** The decrypted key, for the one call that needs it. Never log or return it. */
  async reveal(userId: string, provider: AiProvider): Promise<string> {
    const box = this.requireBox();
    const row = await this.credentials.find(this.prisma, userId, provider);
    if (!row) {
      throw new ConflictError(
        `Add your ${provider === 'gemini' ? 'Gemini' : 'Claude'} API key first.`,
        'AI_KEY_MISSING'
      );
    }
    try {
      return box.decrypt({
        ciphertext: Buffer.from(row.key_ciphertext),
        nonce: Buffer.from(row.key_nonce),
        tag: Buffer.from(row.key_tag),
        keyId: row.key_id,
      });
    } catch (error) {
      if (!(error instanceof SecretBoxError)) throw error;
      throw new ConflictError(
        'Your saved API key can no longer be read. Save it again.',
        'AI_KEY_UNREADABLE'
      );
    }
  }

  private requireBox(): SecretBox {
    if (!this.secretBox) {
      throw new ServiceUnavailableError(
        'Generating testcases with AI is not set up on this server.'
      );
    }
    return this.secretBox;
  }
}
