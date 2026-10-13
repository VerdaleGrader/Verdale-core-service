import type { PrismaClient, User } from '../../../generated/prisma/client';
import { MAJOR_FIELDS, MINOR_FIELDS } from '@/constants/version-fields';
import { ConflictError, ValidationError } from '@/errors';
import TLogger, { Layer } from '@/logging/logger';
import { Db, Prisma, isCheckViolation } from '@/repositories/db';
import HistoryRepository from '@/repositories/history.repository';
import ProblemRepository, { VersionContent } from '@/repositories/problem.repository';
import VerificationRepository from '@/repositories/verification.repository';
import { versionPublishedError, verifyInProgressError } from '@/services/problem/problem.access';
import { Language } from '@/services/problem/problem.mapper';
import ProblemService, { ProblemEditorDto } from '@/services/problem/problem.service';
import {
  FieldChange,
  FieldPatch,
  VersionFieldValues,
  classifyUpdate,
  diffFields,
  versionLabel,
} from '@/services/problem/version-classifier';
import { Page } from '@/services/space/space.mapper';
import { PublicUser, toPublicUser } from '@/services/user/user.mapper';
import { STATEMENT_MAX_LENGTH } from '@/constants/limits';

export interface PublishedUpdateInput extends FieldPatch {
  expected_version: { major: number; minor: number };
  force_major: boolean;
}

export interface UpdateOutcomeDto {
  kind: 'minor' | 'major_draft';
  forced: boolean;
  major_fields: string[];
  label: string;
  editor: ProblemEditorDto;
}

export interface HistoryEntryDto {
  id: string;
  type: 'minor_update' | 'major_draft_created' | 'major_draft_discarded' | 'state_change';
  label: string;
  actor: PublicUser;
  at: string;
  forced: boolean;
  changes: FieldChange[];
  state_from: 'draft' | 'verifying' | 'verified' | 'published' | null;
  state_to: 'draft' | 'verifying' | 'verified' | 'published' | null;
}

const valuesOf = (version: {
  title: string;
  statement: string;
  statement_mode: 'markdown' | 'pdf';
  time_limit_ms: number;
  memory_limit_kb: number;
  allowed_languages: string[];
}): VersionFieldValues => ({
  title: version.title,
  statement: version.statement,
  statement_mode: version.statement_mode,
  time_limit_ms: version.time_limit_ms,
  memory_limit_kb: version.memory_limit_kb,
  allowed_languages: version.allowed_languages,
});

/** The columns that hold a changed field (what an update writes). */
function contentOf(patch: FieldPatch, fields: readonly string[]): VersionContent {
  const content: Record<string, unknown> = {};
  for (const field of fields) {
    const value = patch[field as keyof FieldPatch];
    if (value !== undefined) content[field] = value;
  }
  return content as VersionContent;
}

/**
 * Minor and Major updates of a published problem, Major drafts, and the history
 * (GRD-116, GRD-117, GRD-54). Core decides the type from the fields that really
 * change; the client never picks it. A Minor update edits the open version in
 * place (the database lets a published version change its Minor fields and
 * nothing else); a Major update starts a draft of the next Major.
 */
export default class VersionService {
  private readonly logger = new TLogger(Layer.SERVICE);

  constructor(
    private readonly prisma: PrismaClient,
    private readonly problems: ProblemRepository,
    private readonly history: HistoryRepository,
    private readonly verifications: VerificationRepository,
    private readonly problemService: ProblemService,
    private readonly now: () => Date = () => new Date()
  ) {}

  async updatePublished(
    user: User,
    slug: string,
    problemSlug: string,
    input: PublishedUpdateInput,
    requestId: string
  ): Promise<UpdateOutcomeDto> {
    const logger = this.logger.setContext('service.version.update', requestId);
    const { access, problem: found } = await this.problemService.loadForAuthor(
      this.prisma,
      user,
      'problem.update',
      slug,
      problemSlug
    );
    const patch: FieldPatch = {};
    for (const field of [...MAJOR_FIELDS, ...MINOR_FIELDS]) {
      const value = (input as unknown as Record<string, unknown>)[field];
      if (value !== undefined) (patch as Record<string, unknown>)[field] = value;
    }
    try {
      const outcome = await this.prisma.$transaction(async (tx) => {
        await this.problems.lock(tx, found.id);
        const fresh = (await this.problems.findById(tx, found.id))!;
        this.assertPublished(fresh);
        const open = fresh.current_version!;
        const label = versionLabel(open.version_number, open.minor);
        if (
          input.expected_version.major !== open.version_number ||
          input.expected_version.minor !== open.minor
        ) {
          throw new ConflictError(
            `The open version is now ${label}, not v${input.expected_version.major}.${input.expected_version.minor}. Reload and try again.`,
            'VERSION_CONFLICT',
            [{ field: 'label', message: label }]
          );
        }
        const before = valuesOf(open);
        const kind = classifyUpdate(before, patch, input.force_major);
        const draft = await this.problems.findDraftVersion(tx, fresh.id);
        const changes = diffFields(before, patch);

        if (kind.kind === 'minor') {
          if (kind.minor_fields.length === 0) {
            throw new ValidationError([
              { field: 'body', message: 'No field differs from the open version.' },
            ]);
          }
          this.assertMinorRules(open, patch);
          const content = contentOf(patch, kind.minor_fields);
          const updated = await this.problems.applyMinor(tx, open.id, content);
          const newLabel = versionLabel(updated.version_number, updated.minor);
          await this.history.add(tx, {
            problem_id: fresh.id,
            problem_version_id: open.id,
            type: 'minor_update',
            actor_id: user.id,
            at: this.now(),
            label: newLabel,
            changes: changes as unknown as Prisma.InputJsonValue,
          });
          if (draft) await this.copyMinorIntoDraft(tx, draft, before, kind.minor_fields, patch);
          await this.problems.touch(tx, fresh.id);
          return {
            kind: 'minor' as const,
            forced: false,
            major_fields: [] as string[],
            label: newLabel,
          };
        }

        if (draft) {
          throw new ConflictError(
            `A draft of the next Major (${versionLabel(draft.version_number, draft.minor)}) is already open. Publish or discard it first.`,
            'DRAFT_EXISTS'
          );
        }
        const created = await this.createDraft(tx, fresh.id, open);
        await this.problems.updateVersion(
          tx,
          created.id,
          contentOf(patch, [...MAJOR_FIELDS, ...MINOR_FIELDS])
        );
        const newLabel = versionLabel(created.version_number, created.minor);
        await this.history.add(tx, {
          problem_id: fresh.id,
          problem_version_id: created.id,
          type: 'major_draft_created',
          actor_id: user.id,
          at: this.now(),
          label: newLabel,
          forced: kind.forced,
          changes: changes as unknown as Prisma.InputJsonValue,
          state_from: null,
          state_to: 'draft',
        });
        await this.problems.touch(tx, fresh.id);
        return {
          kind: 'major_draft' as const,
          forced: kind.forced,
          major_fields: kind.major_fields as string[],
          label: newLabel,
        };
      });
      logger.info({
        message: outcome.kind === 'minor' ? 'minor update applied' : 'major draft created',
        data: { problemId: found.id, label: outcome.label, forced: outcome.forced },
      });
      const problem = (await this.problems.findById(this.prisma, found.id))!;
      return {
        ...outcome,
        editor: await this.problemService.editorView(this.prisma, problem, access),
      };
    } catch (error) {
      // The database refuses a Major field of a published version even if a bug got past the checks above.
      if (isCheckViolation(error)) throw versionPublishedError();
      throw error;
    }
  }

  /** POST .../draft: the same copy as a Major update, with no field changes (forced is implied). */
  async createMajorDraft(
    user: User,
    slug: string,
    problemSlug: string,
    requestId: string
  ): Promise<ProblemEditorDto> {
    const logger = this.logger.setContext('service.version.createDraft', requestId);
    const { access, problem: found } = await this.problemService.loadForAuthor(
      this.prisma,
      user,
      'problem.update',
      slug,
      problemSlug
    );
    const created = await this.prisma.$transaction(async (tx) => {
      await this.problems.lock(tx, found.id);
      const fresh = (await this.problems.findById(tx, found.id))!;
      this.assertPublished(fresh);
      const draft = await this.problems.findDraftVersion(tx, fresh.id);
      if (draft) {
        throw new ConflictError(
          `A draft of the next Major (${versionLabel(draft.version_number, draft.minor)}) is already open.`,
          'DRAFT_EXISTS'
        );
      }
      const row = await this.createDraft(tx, fresh.id, fresh.current_version!);
      await this.history.add(tx, {
        problem_id: fresh.id,
        problem_version_id: row.id,
        type: 'major_draft_created',
        actor_id: user.id,
        at: this.now(),
        label: versionLabel(row.version_number, row.minor),
        forced: true,
        state_from: null,
        state_to: 'draft',
      });
      await this.problems.touch(tx, fresh.id);
      return row;
    });
    logger.info({
      message: 'major draft created',
      data: { problemId: found.id, versionId: created.id },
    });
    const problem = (await this.problems.findById(this.prisma, found.id))!;
    return this.problemService.editorView(this.prisma, problem, access);
  }

  /** DELETE .../draft: throws the Major draft away; the open version is untouched. */
  async discardMajorDraft(
    user: User,
    slug: string,
    problemSlug: string,
    requestId: string
  ): Promise<ProblemEditorDto> {
    const logger = this.logger.setContext('service.version.discardDraft', requestId);
    const { access, problem: found } = await this.problemService.loadForAuthor(
      this.prisma,
      user,
      'problem.update',
      slug,
      problemSlug
    );
    await this.prisma.$transaction(async (tx) => {
      await this.problems.lock(tx, found.id);
      const fresh = (await this.problems.findById(tx, found.id))!;
      if (fresh.status === 'archived') {
        throw new ConflictError(
          'This problem is archived and cannot be changed.',
          'PROBLEM_ARCHIVED'
        );
      }
      const draft = await this.problems.findDraftVersion(tx, fresh.id);
      // A problem that was never published keeps its only version: it is deleted, not discarded.
      if (!draft || fresh.status === 'draft') {
        throw new ConflictError('There is no Major draft to discard.', 'NO_DRAFT');
      }
      if (draft.status === 'verifying' || (await this.verifications.findOpen(tx, draft.id))) {
        throw verifyInProgressError();
      }
      await this.history.add(tx, {
        problem_id: fresh.id,
        problem_version_id: draft.id,
        type: 'major_draft_discarded',
        actor_id: user.id,
        at: this.now(),
        label: versionLabel(draft.version_number, draft.minor),
        state_from: draft.status,
        state_to: null,
      });
      await this.problems.deleteVersion(tx, draft.id);
      await this.problems.touch(tx, fresh.id);
    });
    logger.info({ message: 'major draft discarded', data: { problemId: found.id } });
    const problem = (await this.problems.findById(this.prisma, found.id))!;
    return this.problemService.editorView(this.prisma, problem, access);
  }

  /** GET .../history: updates and state changes, newest first (staff, observers included). */
  async historyOf(
    user: User,
    slug: string,
    problemSlug: string,
    input: { page: number; page_size: number }
  ): Promise<Page<HistoryEntryDto>> {
    const { problem } = await this.problemService.loadForAuthor(
      this.prisma,
      user,
      'problem.view_private',
      slug,
      problemSlug
    );
    const { rows, total } = await this.history.list(
      this.prisma,
      problem.id,
      (input.page - 1) * input.page_size,
      input.page_size
    );
    return {
      items: rows.map((row) => ({
        id: row.id,
        type: row.type,
        label: row.label,
        actor: toPublicUser(row.actor),
        at: row.at.toISOString(),
        forced: row.forced,
        changes: row.changes as unknown as FieldChange[],
        state_from: row.state_from,
        state_to: row.state_to,
      })),
      page: input.page,
      page_size: input.page_size,
      total,
    };
  }

  // --- helpers ------------------------------------------------------------

  /** Updates and drafts need a problem that has an open published version. */
  private assertPublished(problem: {
    status: string;
    current_version: { status: string } | null;
  }): void {
    if (problem.status === 'archived') {
      throw new ConflictError(
        'This problem is archived and cannot be changed.',
        'PROBLEM_ARCHIVED'
      );
    }
    if (problem.status !== 'published' || problem.current_version?.status !== 'published') {
      throw new ConflictError(
        'This problem was never published. Edit its draft directly.',
        'NOT_PUBLISHED'
      );
    }
  }

  /** The basic rules of a statement (GRD-117): checked before anything is written. */
  private assertMinorRules(
    open: {
      statement: string;
      statement_mode: 'markdown' | 'pdf';
      statement_pdf_sha256: string | null;
    },
    patch: FieldPatch
  ): void {
    const mode = patch.statement_mode ?? open.statement_mode;
    const statement = patch.statement ?? open.statement;
    if (mode === 'pdf') {
      if (open.statement_pdf_sha256 === null) {
        throw new ValidationError([
          { field: 'statement_mode', message: 'Upload a PDF before choosing the PDF mode.' },
        ]);
      }
    } else if (statement.trim().length === 0) {
      throw new ValidationError([{ field: 'statement', message: 'Write the statement.' }]);
    }
    if (statement.length > STATEMENT_MAX_LENGTH) {
      throw new ValidationError([
        {
          field: 'statement',
          message: `The statement can have at most ${STATEMENT_MAX_LENGTH} characters.`,
        },
      ]);
    }
  }

  /** A Minor change reaches the open Major draft only where the draft has not changed that field itself. */
  private async copyMinorIntoDraft(
    db: Db,
    draft: { id: string } & Record<string, unknown>,
    openBefore: VersionFieldValues,
    fields: readonly string[],
    patch: FieldPatch
  ): Promise<void> {
    const carried = fields.filter(
      (field) => draft[field] === openBefore[field as keyof VersionFieldValues]
    );
    if (carried.length === 0) return;
    await this.problems.updateVersion(db, draft.id, contentOf(patch, carried));
  }

  /** A draft of the next Major with the open version's content, tests and solutions copied. */
  private async createDraft(
    db: Db,
    problemId: string,
    open: Parameters<ProblemRepository['createDraftFrom']>[1] & { id: string }
  ) {
    const created = await this.problems.createDraftFrom(db, {
      ...open,
      problem_id: problemId,
      allowed_languages: open.allowed_languages as Language[],
    });
    await this.problems.copyChildren(db, open.id, created.id);
    return created;
  }
}
