import type { PrismaClient, User } from '../../../generated/prisma/client';
import { ConflictError, NotFoundError } from '@/errors';
import TLogger, { Layer } from '@/logging/logger';
import PlatformRepository from '@/repositories/platform.repository';
import ProblemService from '@/services/problem/problem.service';

export interface ReportProblemInput {
  reason: string;
  category: 'abuse' | 'copyright' | 'cheating' | 'other';
}

/** A user reports a problem they can see (GRD-58). Administrators read the reports. */
export default class ReportService {
  private readonly logger = new TLogger(Layer.SERVICE);

  constructor(
    private readonly prisma: PrismaClient,
    private readonly platform: PlatformRepository,
    private readonly problemService: ProblemService
  ) {}

  async report(
    user: User,
    slug: string,
    problemSlug: string,
    input: ReportProblemInput,
    requestId: string
  ) {
    const { problem, inTrack } = await this.problemService.loadForReader(
      this.prisma,
      user,
      slug,
      problemSlug
    );
    // Only what the person can open: a draft, a taken-down problem or one outside their Tracks does not exist for them.
    if (!inTrack || problem.status === 'draft') throw new NotFoundError('Problem not found.');

    if (await this.platform.findOpenReport(this.prisma, user.id, problem.id)) {
      throw new ConflictError(
        'You have already reported this problem. An administrator will look at it.',
        'ALREADY_REPORTED'
      );
    }
    const report = await this.platform.createReport(this.prisma, {
      problem_id: problem.id,
      reporter_id: user.id,
      category: input.category,
      reason: input.reason,
    });
    this.logger.setContext('service.report.create', requestId).info({
      message: 'problem reported',
      data: { reportId: report.id, problemId: problem.id, category: input.category },
    });
    return { id: report.id, status: report.status, created_at: report.created_at.toISOString() };
  }
}
