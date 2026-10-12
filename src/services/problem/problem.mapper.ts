import type { ProblemVersion, TestCase } from '../../../generated/prisma/client';
import {
  IMAGE_CONTENT_TYPES,
  IMAGE_MAX_BYTES,
  PDF_MAX_BYTES,
  PDF_MAX_PAGES,
  LANGUAGES,
  MEMORY_LIMIT_KB,
  SOLUTIONS_MAX_COUNT,
  SOURCE_MAX_BYTES,
  STATEMENT_MAX_LENGTH,
  TEST_LIMITS,
  TIME_LIMIT_MS,
  TITLE_MAX_LENGTH,
} from '@/constants/limits';
import { InternalServerError } from '@/errors';
import type { ProblemWithVersion } from '@/repositories/problem.repository';
import { PublicUser, toPublicUser } from '@/services/user/user.mapper';

export type Language = 'c' | 'cpp' | 'python';
export type StatementModeName = 'markdown' | 'pdf';

export interface StatementPdfDto {
  size_bytes: number;
  pages: number;
  sha256: string;
}

export function toStatementPdf(version: ProblemVersion): StatementPdfDto | null {
  if (
    !version.statement_pdf_sha256 ||
    version.statement_pdf_size_bytes === null ||
    version.statement_pdf_pages === null
  ) {
    return null;
  }
  return {
    size_bytes: version.statement_pdf_size_bytes,
    pages: version.statement_pdf_pages,
    sha256: version.statement_pdf_sha256,
  };
}

export type ProblemStatusName = 'draft' | 'published' | 'archived';

export interface ProblemConstraintsDto {
  title_max_length: number;
  statement_max_length: number;
  time_limit_ms: { min: number; max: number; default: number };
  memory_limit_kb: { min: number; max: number; default: number };
  languages: Language[];
  tests: TestLimitsDto;
  images: { max_bytes: number; content_types: string[] };
  statement_pdf: { max_bytes: number; max_pages: number };
  solutions: { max_count: number };
  source_max_bytes: number;
}

export type TestLimitsDto = {
  max_count: number;
  max_total_bytes: number;
  max_file_bytes: number;
  max_sample_bytes: number;
  max_samples: number;
};

export function testLimits(): TestLimitsDto {
  return { ...TEST_LIMITS };
}

export function constraints(): ProblemConstraintsDto {
  return {
    title_max_length: TITLE_MAX_LENGTH,
    statement_max_length: STATEMENT_MAX_LENGTH,
    time_limit_ms: { ...TIME_LIMIT_MS },
    memory_limit_kb: { ...MEMORY_LIMIT_KB },
    languages: [...LANGUAGES],
    tests: testLimits(),
    images: { max_bytes: IMAGE_MAX_BYTES, content_types: [...IMAGE_CONTENT_TYPES] },
    statement_pdf: { max_bytes: PDF_MAX_BYTES, max_pages: PDF_MAX_PAGES },
    solutions: { max_count: SOLUTIONS_MAX_COUNT },
    source_max_bytes: SOURCE_MAX_BYTES,
  };
}

export interface ProblemSummaryDto {
  id: string;
  slug: string;
  title: string;
  status: ProblemStatusName;
  version_number: number;
  time_limit_ms: number;
  memory_limit_kb: number;
  allowed_languages: Language[];
  created_by: PublicUser;
  created_at: string;
  updated_at: string;
  published_at: string | null;
}

/** The version solvers see. A problem always has one; null means the data is broken. */
export function currentVersionOf(problem: ProblemWithVersion): ProblemVersion {
  if (!problem.current_version) {
    throw new InternalServerError('The problem has no current version.');
  }
  return problem.current_version;
}

export function toProblemSummary(problem: ProblemWithVersion): ProblemSummaryDto {
  const version = currentVersionOf(problem);
  return {
    id: problem.id,
    slug: problem.slug,
    title: version.title,
    status: problem.status,
    version_number: version.version_number,
    time_limit_ms: version.time_limit_ms,
    memory_limit_kb: version.memory_limit_kb,
    allowed_languages: version.allowed_languages,
    created_by: toPublicUser(problem.created_by),
    created_at: problem.created_at.toISOString(),
    updated_at: problem.updated_at.toISOString(),
    published_at: version.published_at?.toISOString() ?? null,
  };
}

export interface ProblemVersionDto {
  id: string;
  number: number;
  status: 'draft' | 'published';
  title: string;
  statement: string;
  statement_mode: StatementModeName;
  /** The uploaded PDF, kept on the draft even while the mode is Markdown; null when there is none. */
  statement_pdf: StatementPdfDto | null;
  time_limit_ms: number;
  memory_limit_kb: number;
  allowed_languages: Language[];
  created_at: string;
  updated_at: string;
  published_at: string | null;
}

export function toVersionDto(version: ProblemVersion): ProblemVersionDto {
  return {
    id: version.id,
    number: version.version_number,
    status: version.status,
    title: version.title,
    statement: version.statement,
    statement_mode: version.statement_mode,
    statement_pdf: toStatementPdf(version),
    time_limit_ms: version.time_limit_ms,
    memory_limit_kb: version.memory_limit_kb,
    allowed_languages: version.allowed_languages,
    created_at: version.created_at.toISOString(),
    updated_at: version.updated_at.toISOString(),
    published_at: version.published_at?.toISOString() ?? null,
  };
}

export interface TestCaseDto {
  id: string;
  position: number;
  is_sample: boolean;
  input_sha256: string;
  /** Null while the expected output is still to be created (paste without one, or generate it). */
  output_sha256: string | null;
  input_size_bytes: number;
  output_size_bytes: number | null;
  created_at: string;
}

export function toTestCaseDto(test: TestCase): TestCaseDto {
  return {
    id: test.id,
    position: test.position,
    is_sample: test.is_sample,
    input_sha256: test.input_sha256,
    output_sha256: test.output_sha256,
    input_size_bytes: test.input_size_bytes,
    output_size_bytes: test.output_size_bytes,
    created_at: test.created_at.toISOString(),
  };
}

export interface TestSummaryDto {
  count: number;
  sample_count: number;
  /** Testcases still waiting for an expected output (paste without one, or to generate). */
  missing_output_count: number;
  total_bytes: number;
}
