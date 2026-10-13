import { MAJOR_FIELDS, MINOR_FIELDS, MajorField, MinorField } from '@/constants/version-fields';

/** The fields of a version a published-problem update may carry. */
export interface VersionFieldValues {
  title: string;
  statement: string;
  statement_mode: 'markdown' | 'pdf';
  time_limit_ms: number;
  memory_limit_kb: number;
  allowed_languages: string[];
}

export type FieldPatch = Partial<VersionFieldValues>;

export interface FieldChange {
  field: string;
  old: string | null;
  new: string | null;
}

export interface Classification {
  kind: 'minor' | 'major';
  /** Major only because `force_major` was set. */
  forced: boolean;
  /** Fields whose value really changes, per group. */
  major_fields: MajorField[];
  minor_fields: MinorField[];
}

const sameLanguages = (left: string[], right: string[]) =>
  left.length === right.length && [...left].sort().join() === [...right].sort().join();

/** True when the submitted value differs from the one the version has. */
export function fieldChanged(
  field: keyof VersionFieldValues,
  current: VersionFieldValues,
  incoming: FieldPatch
): boolean {
  const value = incoming[field];
  if (value === undefined) return false;
  if (field === 'allowed_languages') {
    return !sameLanguages(current.allowed_languages, value as string[]);
  }
  return current[field] !== value;
}

/**
 * Decides whether an update is Minor or Major from the fields that really
 * change compared with the open version (GRD-116). The client never chooses:
 * a value equal to the current one is not a change; one Major field that
 * changes makes the whole update Major, with any Minor fields riding along;
 * `force_major` makes it Major even when nothing Major changed.
 */
export function classifyUpdate(
  current: VersionFieldValues,
  incoming: FieldPatch,
  forceMajor: boolean
): Classification {
  const keys = Object.keys(incoming) as Array<keyof VersionFieldValues>;
  const changed = keys.filter((field) => fieldChanged(field, current, incoming));
  const major_fields = MAJOR_FIELDS.filter((field) =>
    (changed as string[]).includes(field)
  ) as MajorField[];
  const minor_fields = MINOR_FIELDS.filter((field) =>
    (changed as string[]).includes(field)
  ) as MinorField[];
  const isMajor = major_fields.length > 0 || forceMajor;
  return {
    kind: isMajor ? 'major' : 'minor',
    forced: forceMajor && major_fields.length === 0,
    major_fields,
    minor_fields,
  };
}

const TEXT_CUT = 2000;

const cut = (text: string) => (text.length > TEXT_CUT ? text.slice(0, TEXT_CUT) : text);

/** How a field's value is written into a history entry (text cut, lists joined with commas). */
export function describeValue(value: string | number | string[] | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return [...value].sort().join(',');
  return cut(String(value));
}

/** One entry per field that changes: who, when and which are kept by the caller. */
export function diffFields(current: VersionFieldValues, incoming: FieldPatch): FieldChange[] {
  const changes: FieldChange[] = [];
  for (const field of [...MAJOR_FIELDS, ...MINOR_FIELDS] as string[]) {
    const key = field as keyof VersionFieldValues;
    if (!(key in current) || !fieldChanged(key, current, incoming)) continue;
    changes.push({
      field,
      old: describeValue(current[key]),
      new: describeValue(incoming[key]),
    });
  }
  return changes;
}

export const versionLabel = (major: number, minor: number) => `v${major}.${minor}`;
