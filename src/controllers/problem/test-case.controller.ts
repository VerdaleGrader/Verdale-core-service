import type { FastifyReply, FastifyRequest } from 'fastify';
import { TEST_LIMITS } from '@/constants/limits';
import { ValidationError } from '@/errors';
import { readUploads } from '@/controllers/upload';
import { requireUser } from '@/middleware/session';
import ProblemService from '@/services/problem/problem.service';
import TestCaseService from '@/services/problem/test-case.service';
import GenerateService from '@/services/problem/generate.service';
import {
  batchTestsBody,
  fileSliceQuery,
  generateBody,
  generateParams,
  problemSlugParams,
  reorderTestsBody,
  stageTextBody,
  testFileParams,
  testParams,
  updateTestBody,
} from '@/validation/schemas';

const FILE_FIELDS = ['input', 'output'];

function parseBoolean(value: string | undefined, field: string): boolean {
  if (value === undefined || value === '') return false;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new ValidationError([{ field, message: 'Use true or false.' }]);
}

export default class TestCaseController {
  constructor(
    private readonly testService: TestCaseService,
    private readonly problemService: ProblemService,
    private readonly generateService: GenerateService
  ) {}

  /** GET .../tests */
  async list(request: FastifyRequest, reply: FastifyReply) {
    const user = requireUser(request);
    const { slug, problemSlug } = problemSlugParams.parse(request.params);
    return reply.send(await this.testService.list(user, slug, problemSlug));
  }

  /** POST .../tests (multipart: input, output, is_sample) */
  async create(request: FastifyRequest, reply: FastifyReply) {
    const user = requireUser(request);
    const { slug, problemSlug } = problemSlugParams.parse(request.params);
    await this.problemService.authorize(user, 'problem.update', slug, problemSlug);
    const { files, fields } = await readUploads(request, {
      maxFileBytes: TEST_LIMITS.max_file_bytes,
      fileFields: FILE_FIELDS,
    });
    const missing = FILE_FIELDS.filter((name) => !files[name]);
    if (missing.length > 0) {
      throw new ValidationError(
        missing.map((field) => ({ field, message: `Add the ${field} file.` }))
      );
    }
    const created = await this.testService.create(
      user,
      slug,
      problemSlug,
      {
        input: files.input!,
        output: files.output!,
        is_sample: parseBoolean(fields.is_sample, 'is_sample'),
      },
      request.id
    );
    return reply.status(201).send(created);
  }

  /** PUT .../tests/:testId (multipart: input and/or output) */
  async replace(request: FastifyRequest, reply: FastifyReply) {
    const user = requireUser(request);
    const { slug, problemSlug, testId } = testParams.parse(request.params);
    await this.problemService.authorize(user, 'problem.update', slug, problemSlug);
    const { files } = await readUploads(request, {
      maxFileBytes: TEST_LIMITS.max_file_bytes,
      fileFields: FILE_FIELDS,
    });
    return reply.send(
      await this.testService.replace(
        user,
        slug,
        problemSlug,
        testId,
        { input: files.input, output: files.output },
        request.id
      )
    );
  }

  /** PATCH .../tests/:testId */
  async update(request: FastifyRequest, reply: FastifyReply) {
    const user = requireUser(request);
    const { slug, problemSlug, testId } = testParams.parse(request.params);
    const { is_sample } = updateTestBody.parse(request.body);
    return reply.send(
      await this.testService.setSample(user, slug, problemSlug, testId, is_sample, request.id)
    );
  }

  /** DELETE .../tests/:testId */
  async remove(request: FastifyRequest, reply: FastifyReply) {
    const user = requireUser(request);
    const { slug, problemSlug, testId } = testParams.parse(request.params);
    await this.testService.remove(user, slug, problemSlug, testId, request.id);
    return reply.status(204).send();
  }

  /** POST .../tests/reorder */
  async reorder(request: FastifyRequest, reply: FastifyReply) {
    const user = requireUser(request);
    const { slug, problemSlug } = problemSlugParams.parse(request.params);
    const { test_ids } = reorderTestsBody.parse(request.body);
    return reply.send(
      await this.testService.reorder(user, slug, problemSlug, test_ids, request.id)
    );
  }

  /** POST .../tests/files: multipart `file`, or JSON `{ text }` for pasted text. */
  async stageFile(request: FastifyRequest, reply: FastifyReply) {
    const user = requireUser(request);
    const { slug, problemSlug } = problemSlugParams.parse(request.params);
    await this.problemService.authorize(user, 'problem.update', slug, problemSlug);
    let file: { filename: string; bytes: Buffer };
    if (request.isMultipart()) {
      const { files } = await readUploads(request, {
        maxFileBytes: TEST_LIMITS.max_file_bytes,
        fileFields: ['file'],
      });
      if (!files.file) {
        throw new ValidationError([{ field: 'file', message: 'Add the file.' }]);
      }
      file = files.file;
    } else {
      file = { filename: '', bytes: Buffer.from(stageTextBody.parse(request.body).text, 'utf8') };
    }
    return reply.status(201).send(await this.testService.stageFile(user, slug, problemSlug, file));
  }

  /** PUT .../tests: every change of the page, saved together. */
  async batchSave(request: FastifyRequest, reply: FastifyReply) {
    const user = requireUser(request);
    const { slug, problemSlug } = problemSlugParams.parse(request.params);
    return reply.send(
      await this.testService.batchSave(
        user,
        slug,
        problemSlug,
        batchTestsBody.parse(request.body),
        request.id
      )
    );
  }

  /** GET .../tests/:testId/files/:side: a window of lines for the preview and "View all". */
  async slice(request: FastifyRequest, reply: FastifyReply) {
    const user = requireUser(request);
    const { slug, problemSlug, testId, side } = testFileParams.parse(request.params);
    const query = fileSliceQuery.parse(request.query);
    return reply.send(
      await this.testService.slice(user, slug, problemSlug, testId, side, {
        fromLine: query.from_line,
        maxLines: query.max_lines,
      })
    );
  }

  // --- generate expected output from a solution -----------------------------

  /** POST .../generate */
  async generate(request: FastifyRequest, reply: FastifyReply) {
    const user = requireUser(request);
    const { slug, problemSlug } = problemSlugParams.parse(request.params);
    const job = await this.generateService.start(
      user,
      slug,
      problemSlug,
      generateBody.parse(request.body),
      request.id
    );
    return reply.status(202).send(job);
  }

  /** GET .../generate/:jobId */
  async generateStatus(request: FastifyRequest, reply: FastifyReply) {
    const user = requireUser(request);
    const { slug, problemSlug, jobId } = generateParams.parse(request.params);
    return reply.send(await this.generateService.get(user, slug, problemSlug, jobId));
  }

  /** POST .../generate/:jobId/stop */
  async generateStop(request: FastifyRequest, reply: FastifyReply) {
    const user = requireUser(request);
    const { slug, problemSlug, jobId } = generateParams.parse(request.params);
    return reply.send(await this.generateService.stop(user, slug, problemSlug, jobId, request.id));
  }

  /** GET .../tests/:testId/input and /output. `?inline=true` opens it as text instead of saving it. */
  async download(request: FastifyRequest, reply: FastifyReply, side: 'input' | 'output') {
    const user = requireUser(request);
    const { slug, problemSlug, testId } = testParams.parse(request.params);
    const { inline } = fileSliceQuery.parse(request.query);
    const file = await this.testService.download(user, slug, problemSlug, testId, side);
    return reply
      .type('text/plain; charset=utf-8')
      .header('Content-Length', file.size)
      .header(
        'Content-Disposition',
        `${inline ? 'inline' : 'attachment'}; filename="${file.fileName}"`
      )
      .header('X-Content-Type-Options', 'nosniff')
      .header('Cache-Control', 'private, no-store')
      .send(file.body);
  }
}
