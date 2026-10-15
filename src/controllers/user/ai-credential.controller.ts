import type { FastifyReply, FastifyRequest } from 'fastify';
import { requireUser } from '@/middleware/session';
import AiCredentialService from '@/services/user/ai-credential.service';
import { aiProviderParams, saveAiKeyBody } from '@/validation/schemas';

export default class AiCredentialController {
  constructor(private readonly credentials: AiCredentialService) {}

  /** GET /api/v1/me/ai-credentials: provider and last four characters, never the key. */
  async list(request: FastifyRequest, reply: FastifyReply) {
    const user = requireUser(request);
    return reply.send({
      enabled: this.credentials.enabled,
      items: await this.credentials.list(user),
    });
  }

  /** PUT /api/v1/me/ai-credentials/:provider */
  async save(request: FastifyRequest, reply: FastifyReply) {
    const user = requireUser(request);
    const { provider } = aiProviderParams.parse(request.params);
    const { api_key } = saveAiKeyBody.parse(request.body);
    return reply.send(await this.credentials.save(user, provider, api_key, request.id));
  }

  /** DELETE /api/v1/me/ai-credentials/:provider */
  async remove(request: FastifyRequest, reply: FastifyReply) {
    const user = requireUser(request);
    const { provider } = aiProviderParams.parse(request.params);
    await this.credentials.remove(user, provider, request.id);
    return reply.status(204).send();
  }
}
