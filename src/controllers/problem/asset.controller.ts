import type { FastifyReply, FastifyRequest } from 'fastify';
import ImageService from '@/services/problem/image.service';
import { assetParams } from '@/validation/schemas';

/** Serves statement pictures when the public bucket has no public domain of its own. */
export default class AssetController {
  constructor(private readonly imageService: ImageService) {}

  /** GET /api/v1/assets/:name */
  async get(request: FastifyRequest, reply: FastifyReply) {
    const parsed = assetParams.safeParse(request.params);
    if (!parsed.success) return reply.callNotFound();
    const image = await this.imageService.read(parsed.data.name);
    return (
      reply
        .type(image.contentType)
        .header('Content-Length', image.size)
        // Names are random and never reused, so a picture never changes.
        .header('Cache-Control', 'public, max-age=31536000, immutable')
        .header('X-Content-Type-Options', 'nosniff')
        .header('Content-Security-Policy', "default-src 'none'; sandbox")
        .send(image.body)
    );
  }
}
