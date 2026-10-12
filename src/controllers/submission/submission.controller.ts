import type { FastifyReply, FastifyRequest } from 'fastify';
import { requireUser } from '@/middleware/session';
import SubmissionService from '@/services/submission/submission.service';
import {
  createSubmissionBody,
  problemSlugParams,
  submissionListQuery,
  submissionParams,
} from '@/validation/schemas';

/** How long one event stream stays open; the browser reconnects and gets the current state again. */
const STREAM_MAX_MS = 5 * 60 * 1000;
const KEEP_ALIVE_MS = 15_000;

const sleep = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

export default class SubmissionController {
  constructor(
    private readonly submissionService: SubmissionService,
    /** How often a stream looks for a change. */
    private readonly streamIntervalMs = 1000
  ) {}

  /** POST /api/v1/spaces/:slug/problems/:problemSlug/submissions */
  async create(request: FastifyRequest, reply: FastifyReply) {
    const user = requireUser(request);
    const { slug, problemSlug } = problemSlugParams.parse(request.params);
    const submission = await this.submissionService.create(
      user,
      slug,
      problemSlug,
      createSubmissionBody.parse(request.body),
      request.id
    );
    return reply.status(202).send(submission);
  }

  /** GET /api/v1/spaces/:slug/problems/:problemSlug/submissions */
  async list(request: FastifyRequest, reply: FastifyReply) {
    const user = requireUser(request);
    const { slug, problemSlug } = problemSlugParams.parse(request.params);
    return reply.send(
      await this.submissionService.list(
        user,
        slug,
        problemSlug,
        submissionListQuery.parse(request.query)
      )
    );
  }

  /** GET /api/v1/submissions/:submissionId */
  async get(request: FastifyRequest, reply: FastifyReply) {
    const user = requireUser(request);
    const { submissionId } = submissionParams.parse(request.params);
    return reply.send(await this.submissionService.get(user, submissionId));
  }

  /** POST /api/v1/submissions/:submissionId/rejudge */
  async rejudge(request: FastifyRequest, reply: FastifyReply) {
    const user = requireUser(request);
    const { submissionId } = submissionParams.parse(request.params);
    return reply
      .status(202)
      .send(await this.submissionService.rejudge(user, submissionId, request.id));
  }

  /**
   * GET /api/v1/submissions/:submissionId/events: Server-Sent Events.
   * Every connection starts with the current state, so a dropped connection
   * loses nothing; the browser's EventSource reconnects by itself.
   */
  async events(request: FastifyRequest, reply: FastifyReply) {
    const user = requireUser(request);
    const { submissionId } = submissionParams.parse(request.params);
    // The first read happens before the stream starts, so "not found" and
    // "log in" are ordinary JSON errors.
    let current = await this.submissionService.get(user, submissionId, { includeSource: false });

    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      // no-transform keeps compression (and its buffering) away from the stream.
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'X-Request-Id': request.id,
    });
    let closed = false;
    request.raw.on('close', () => {
      closed = true;
    });
    const write = (text: string) => {
      if (!closed && !raw.writableEnded) raw.write(text);
    };

    write('retry: 3000\n\n');
    let lastSent = '';
    let lastWrite = Date.now();
    const send = (state: typeof current) => {
      const data = JSON.stringify(state);
      if (data === lastSent) return;
      lastSent = data;
      lastWrite = Date.now();
      write(`event: submission\ndata: ${data}\n\n`);
    };
    send(current);

    const startedAt = Date.now();
    let tick = 0;
    while (!closed && current.status !== 'completed' && Date.now() - startedAt < STREAM_MAX_MS) {
      await sleep(this.streamIntervalMs);
      if (closed) break;
      try {
        // Ask Judge whether the job started every other pass.
        current = await this.submissionService.get(user, submissionId, {
          includeSource: false,
          pollJudge: tick++ % 2 === 0,
        });
      } catch {
        break; // the submission vanished or the viewer lost access: end the stream
      }
      send(current);
      if (Date.now() - lastWrite >= KEEP_ALIVE_MS) {
        lastWrite = Date.now();
        write(': keep-alive\n\n');
      }
    }
    if (!raw.writableEnded) raw.end();
  }
}
