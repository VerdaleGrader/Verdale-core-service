/**
 * The ONE place that says which fields of a problem version are Major and which
 * are Minor (GRD-116). Everything else reads this list: the classifier, the
 * 409 `MAJOR_FIELD_LOCKED` guard, the history, and `constraints.version_fields`
 * that the web app shows.
 *
 * Major: changing any of them changes what a correct solution is or how it is
 * judged, so a published version cannot take it directly. It needs a draft of
 * the next Major that passes verification and the publish rules.
 * Minor: wording and presentation. Applied in place on the open version.
 *
 * ANY NEW FIELD OF A PROBLEM VERSION MUST BE ADDED TO ONE OF THESE TWO GROUPS
 * (and to the database trigger `forbid_published_version_edit` if it is Major).
 * A field in neither group is a field nobody has decided about.
 */
export const MAJOR_FIELDS = [
  'time_limit_ms',
  'memory_limit_kb',
  'allowed_languages',
  // Test input and output, their order and Visible to solvers (is_sample).
  'tests',
  // Reference solutions.
  'solutions',
] as const;

export const MINOR_FIELDS = ['title', 'statement', 'statement_mode'] as const;

export type MajorField = (typeof MAJOR_FIELDS)[number];
export type MinorField = (typeof MINOR_FIELDS)[number];

/** The Minor fields that live in columns together with the PDF statement they select. */
export const MINOR_PDF_COLUMNS = [
  'statement_pdf_sha256',
  'statement_pdf_size_bytes',
  'statement_pdf_pages',
] as const;

export function versionFields() {
  return { major: [...MAJOR_FIELDS], minor: [...MINOR_FIELDS] };
}

export const isMajorField = (field: string): field is MajorField =>
  (MAJOR_FIELDS as readonly string[]).includes(field);
