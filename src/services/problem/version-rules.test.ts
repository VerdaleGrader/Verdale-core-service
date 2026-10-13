import { MAJOR_FIELDS, MINOR_FIELDS, versionFields } from '@/constants/version-fields';
import { contentHash } from '@/services/problem/content-hash';
import { buildPublishChecks } from '@/services/problem/publish-checks';
import { TRANSITIONS, assertTransition, canTransition } from '@/services/problem/transitions';
import {
  VersionFieldValues,
  classifyUpdate,
  diffFields,
  versionLabel,
} from '@/services/problem/version-classifier';

const open: VersionFieldValues = {
  title: 'Sum',
  statement: 'Add them.',
  statement_mode: 'markdown',
  time_limit_ms: 1000,
  memory_limit_kb: 262144,
  allowed_languages: ['c', 'cpp'],
};

describe('version field groups', () => {
  it('lists every field once, in one group', () => {
    const all = [...MAJOR_FIELDS, ...MINOR_FIELDS] as string[];
    expect(new Set(all).size).toBe(all.length);
    expect(versionFields().major).toContain('tests');
    expect(versionFields().minor).toEqual(['title', 'statement', 'statement_mode']);
  });
});

describe('classifyUpdate', () => {
  it('is Minor when only Minor fields change', () => {
    const result = classifyUpdate(open, { title: 'Sum two', statement: 'New text' }, false);
    expect(result).toMatchObject({ kind: 'minor', forced: false, major_fields: [] });
    expect(result.minor_fields).toEqual(['title', 'statement']);
  });

  it('is Major when one Major field changes, and the Minor fields ride along', () => {
    const result = classifyUpdate(open, { title: 'Other', time_limit_ms: 2000 }, false);
    expect(result).toMatchObject({ kind: 'major', forced: false, major_fields: ['time_limit_ms'] });
    expect(result.minor_fields).toEqual(['title']);
  });

  it('ignores a Major field sent with its current value', () => {
    const result = classifyUpdate(
      open,
      { time_limit_ms: 1000, allowed_languages: ['cpp', 'c'], title: 'Other' },
      false
    );
    expect(result.kind).toBe('minor');
  });

  it('force_major makes it Major and says it was forced only when no Major field changed', () => {
    expect(classifyUpdate(open, { title: 'Other' }, true)).toMatchObject({
      kind: 'major',
      forced: true,
    });
    expect(classifyUpdate(open, { memory_limit_kb: 1 }, true)).toMatchObject({
      kind: 'major',
      forced: false,
    });
  });

  it('describes each change with old and new value, cutting long text', () => {
    const changes = diffFields(open, {
      title: 'Other',
      statement: 'x'.repeat(5000),
      allowed_languages: ['python'],
    });
    expect(changes.map((change) => change.field)).toEqual([
      'allowed_languages',
      'title',
      'statement',
    ]);
    expect(changes[0]).toEqual({ field: 'allowed_languages', old: 'c,cpp', new: 'python' });
    expect(changes[2]!.new).toHaveLength(2000);
    expect(versionLabel(2, 1)).toBe('v2.1');
  });
});

describe('state machine', () => {
  it('allows exactly the planned moves', () => {
    expect(canTransition('draft', 'verifying')).toBe(true);
    expect(canTransition('verifying', 'verified')).toBe(true);
    expect(canTransition('verifying', 'draft')).toBe(true);
    expect(canTransition('verified', 'draft')).toBe(true);
    expect(canTransition('verified', 'published')).toBe(true);
    expect(canTransition('published', 'archived')).toBe(true);
    expect(canTransition('draft', 'published')).toBe(false);
    expect(canTransition('draft', 'verified')).toBe(false);
    expect(canTransition('published', 'draft')).toBe(false);
    expect(canTransition('archived', 'published')).toBe(false);
  });

  it('names who may publish and which moves Core makes itself', () => {
    expect(assertTransition('verified', 'published').action).toBe('problem.publish');
    expect(assertTransition('verifying', 'verified').action).toBeNull();
    expect(() => assertTransition('draft', 'published')).toThrow(
      /cannot go from draft to published/
    );
    expect(TRANSITIONS.filter((move) => move.to === 'published')).toHaveLength(1);
  });
});

describe('contentHash', () => {
  const base = {
    tests: [
      { position: 2, input_sha256: 'b', output_sha256: 'bb', is_sample: false },
      { position: 1, input_sha256: 'a', output_sha256: 'aa', is_sample: true },
    ],
    solutions: [
      { language: 'cpp', source: 'int main(){}', is_primary: true },
      { language: 'python', source: 'print(1)', is_primary: false },
    ],
    time_limit_ms: 1000,
    memory_limit_kb: 262144,
    allowed_languages: ['c', 'cpp'],
  };

  it('is the same for the same content however it was read', () => {
    const shuffled = {
      ...base,
      tests: [...base.tests].reverse(),
      solutions: [...base.solutions].reverse(),
      allowed_languages: ['cpp', 'c'],
    };
    expect(contentHash(shuffled)).toBe(contentHash(base));
    expect(contentHash(base)).toMatch(/^[a-f0-9]{64}$/);
  });

  it('changes with a test, its order or visibility, a solution, a limit or the languages', () => {
    const hash = contentHash(base);
    const changed = [
      { ...base, tests: [{ ...base.tests[0]!, output_sha256: 'zz' }, base.tests[1]!] },
      {
        ...base,
        tests: [
          { ...base.tests[0]!, position: 1 },
          { ...base.tests[1]!, position: 2 },
        ],
      },
      { ...base, tests: [base.tests[0]!, { ...base.tests[1]!, is_sample: false }] },
      { ...base, solutions: [{ ...base.solutions[0]!, source: 'int main(){return 0;}' }] },
      { ...base, time_limit_ms: 2000 },
      { ...base, memory_limit_kb: 131072 },
      { ...base, allowed_languages: ['c'] },
    ];
    for (const content of changed) expect(contentHash(content)).not.toBe(hash);
  });
});

describe('buildPublishChecks', () => {
  const facts = {
    statement: 'Add.',
    languageCount: 1,
    testCount: 3,
    sampleCount: 1,
    missingOutputCount: 0,
    hasPrimarySolution: true,
    timeLimitMs: 1000,
    memoryLimitKb: 262144,
    minHiddenTests: 2,
    verified: true,
  };
  const failing = (overrides: Partial<typeof facts>) =>
    buildPublishChecks({ ...facts, ...overrides })
      .filter((check) => !check.ok)
      .map((check) => check.key);

  it('passes when everything is in place', () => {
    expect(failing({})).toEqual([]);
  });

  it('names each failing check', () => {
    expect(failing({ testCount: 2 })).toEqual(['hidden_tests']);
    expect(failing({ minHiddenTests: 0, testCount: 1 })).toEqual([]);
    expect(failing({ timeLimitMs: 50 })).toEqual(['limits']);
    expect(failing({ memoryLimitKb: 1 })).toEqual(['limits']);
    expect(failing({ verified: false })).toEqual(['verified']);
    expect(failing({ sampleCount: 0 })).toEqual(['sample_test']);
  });

  it('says how many hidden tests are missing', () => {
    const message = buildPublishChecks({ ...facts, testCount: 1 }).find(
      (check) => check.key === 'hidden_tests'
    )!.message;
    expect(message).toContain('at least 2');
    expect(message).toContain('there are 0');
  });
});
