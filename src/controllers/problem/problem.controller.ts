import type { FastifyReply, FastifyRequest } from 'fastify';
import { IMAGE_MAX_BYTES, PDF_MAX_BYTES } from '@/constants/limits';
import { ValidationError } from '@/errors';
import { readUploads } from '@/controllers/upload';
import { requireUser } from '@/middleware/session';
import ImageService from '@/services/problem/image.service';
import ProblemService from '@/services/problem/problem.service';
import StatementService from '@/services/problem/statement.service';
import {
  createProblemBody,
  problemListQuery,
  problemSlugParams,
  slugParams,
  statementPdfQuery,
  updateProblemBody,
} from '@/validation/schemas';

export default class ProblemController {
  constructor(
    private readonly problemService: ProblemService,
    private readonly imageService: ImageService,
    private readonly statementService: StatementService
  ) {}

  /** GET /api/v1/problem-constraints: the ranges the editor must respect, for the create page (no problem exists yet). */
  async constraints(_request: FastifyRequest, reply: FastifyReply) {
    return reply.send(this.problemService.constraints());
  }

  /** GET /api/v1/spaces/:slug/problems */
  async list(request: FastifyRequest, reply: FastifyReply) {
    const { slug } = slugParams.parse(request.params);
    return reply.send(
      await this.problemService.list(
        request.currentUser,
        slug,
        problemListQuery.parse(request.query)
      )
    );
  }

  /** POST /api/v1/spaces/:slug/problems */
  async create(request: FastifyRequest, reply: FastifyReply) {
    const user = requireUser(request);
    const { slug } = slugParams.parse(request.params);
    const problem = await this.problemService.create(
      user,
      slug,
      createProblemBody.parse(request.body),
      request.id
    );
    return reply.status(201).send(problem);
  }

  /** GET /api/v1/spaces/:slug/problems/:problemSlug */
  async get(request: FastifyRequest, reply: FastifyReply) {
    const { slug, problemSlug } = problemSlugParams.parse(request.params);
    return reply.send(await this.problemService.get(request.currentUser, slug, problemSlug));
  }

  /** GET /api/v1/spaces/:slug/problems/:problemSlug/editor */
  async editor(request: FastifyRequest, reply: FastifyReply) {
    const user = requireUser(request);
    const { slug, problemSlug } = problemSlugParams.parse(request.params);
    return reply.send(await this.problemService.editor(user, slug, problemSlug));
  }

  /** PATCH /api/v1/spaces/:slug/problems/:problemSlug */
  async update(request: FastifyRequest, reply: FastifyReply) {
    const user = requireUser(request);
    const { slug, problemSlug } = problemSlugParams.parse(request.params);
    return reply.send(
      await this.problemService.update(
        user,
        slug,
        problemSlug,
        updateProblemBody.parse(request.body),
        request.id
      )
    );
  }

  /** DELETE /api/v1/spaces/:slug/problems/:problemSlug */
  async remove(request: FastifyRequest, reply: FastifyReply) {
    const user = requireUser(request);
    const { slug, problemSlug } = problemSlugParams.parse(request.params);
    await this.problemService.delete(user, slug, problemSlug, request.id);
    return reply.status(204).send();
  }

  /** POST /api/v1/spaces/:slug/problems/:problemSlug/publish */
  async publish(request: FastifyRequest, reply: FastifyReply) {
    const user = requireUser(request);
    const { slug, problemSlug } = problemSlugParams.parse(request.params);
    return reply.send(await this.problemService.publish(user, slug, problemSlug, request.id));
  }

  /** POST /api/v1/spaces/:slug/problems/:problemSlug/archive */
  async archive(request: FastifyRequest, reply: FastifyReply) {
    const user = requireUser(request);
    const { slug, problemSlug } = problemSlugParams.parse(request.params);
    return reply.send(await this.problemService.archive(user, slug, problemSlug, request.id));
  }

  /** POST /api/v1/spaces/:slug/problems/:problemSlug/images */
  async uploadImage(request: FastifyRequest, reply: FastifyReply) {
    const user = requireUser(request);
    const { slug, problemSlug } = problemSlugParams.parse(request.params);
    // Check the right to upload before reading what may be a large body.
    await this.problemService.authorize(user, 'problem.update', slug, problemSlug);
    const { files } = await readUploads(request, {
      maxFileBytes: IMAGE_MAX_BYTES,
      fileFields: ['file'],
    });
    if (!files.file) {
      throw new ValidationError([{ field: 'file', message: 'Choose an image to upload.' }]);
    }
    const uploaded = await this.imageService.upload(
      user,
      slug,
      problemSlug,
      files.file,
      request.id
    );
    return reply.status(201).send(uploaded);
  }

  /** PUT /api/v1/spaces/:slug/problems/:problemSlug/statement/pdf */
  async uploadStatementPdf(request: FastifyRequest, reply: FastifyReply) {
    const user = requireUser(request);
    const { slug, problemSlug } = problemSlugParams.parse(request.params);
    // Check the right to edit before reading what may be a 10 MiB body.
    await this.problemService.authorize(user, 'problem.update', slug, problemSlug);
    const { files } = await readUploads(request, {
      maxFileBytes: PDF_MAX_BYTES,
      fileFields: ['file'],
    });
    if (!files.file) {
      throw new ValidationError([{ field: 'file', message: 'Choose a PDF file to upload.' }]);
    }
    return reply.send(
      await this.statementService.uploadPdf(user, slug, problemSlug, files.file, request.id)
    );
  }

  /** GET /api/v1/spaces/:slug/problems/:problemSlug/statement/pdf */
  async statementPdf(request: FastifyRequest, reply: FastifyReply) {
    const { slug, problemSlug } = problemSlugParams.parse(request.params);
    const { draft } = statementPdfQuery.parse(request.query);
    const pdf = await this.statementService.readPdf(request.currentUser, slug, problemSlug, {
      draft,
    });
    return (
      reply
        .type('application/pdf')
        .header('Content-Length', pdf.size)
        .header('Content-Disposition', 'inline; filename="statement.pdf"')
        // The browser must not guess another type, run anything inside the file, or let
        // another site embed it. The bytes are content-addressed, but access is per request.
        .header('X-Content-Type-Options', 'nosniff')
        .header('Content-Security-Policy', "default-src 'none'; sandbox")
        .header('Cross-Origin-Resource-Policy', 'same-origin')
        .header('Cache-Control', 'private, max-age=300')
        .header('ETag', `"${pdf.sha256}"`)
        .send(pdf.body)
    );
  }
}
