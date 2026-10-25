import type { AuditRecord, ReportRecord } from '@/repositories/platform.repository';

export interface ReportDto {
  id: string;
  status: 'open' | 'dismissed' | 'actioned';
  category: 'abuse' | 'copyright' | 'cheating' | 'other';
  reason: string;
  created_at: string;
  reporter: { username: string; display_name: string };
  problem: {
    space: string;
    slug: string;
    title: string;
    status: 'draft' | 'published' | 'archived';
    suspended: boolean;
  };
  resolved_at: string | null;
  resolved_by: string | null;
  resolution_note: string | null;
}

export function toReportDto(report: ReportRecord): ReportDto {
  return {
    id: report.id,
    status: report.status,
    category: report.category,
    reason: report.reason,
    created_at: report.created_at.toISOString(),
    reporter: { username: report.reporter.username, display_name: report.reporter.display_name },
    problem: {
      space: report.problem.space.slug,
      slug: report.problem.slug,
      title: report.problem.current_version?.title ?? report.problem.slug,
      status: report.problem.status,
      suspended: report.problem.suspended_at !== null,
    },
    resolved_at: report.resolved_at?.toISOString() ?? null,
    resolved_by: report.resolved_by?.username ?? null,
    resolution_note: report.resolution_note,
  };
}

export interface AuditEntryDto {
  id: string;
  action: string;
  target_type: string;
  target_id: string | null;
  target_label: string;
  /** Username of the administrator; null for work done on the command line. */
  actor: string | null;
  data: unknown;
  created_at: string;
}

export function toAuditEntryDto(entry: AuditRecord): AuditEntryDto {
  return {
    id: entry.id,
    action: entry.action,
    target_type: entry.target_type,
    target_id: entry.target_id,
    target_label: entry.target_label,
    actor: entry.actor?.username ?? null,
    data: entry.data,
    created_at: entry.created_at.toISOString(),
  };
}
