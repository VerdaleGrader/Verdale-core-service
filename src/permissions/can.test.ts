import {
  ACTIONS,
  Action,
  Actor,
  Resource,
  SpaceRoleName,
  can,
  canAssignRole,
  canRemoveMember,
} from '@/permissions/can';

const user: Actor = { userId: 'user-1' };
type Visibility = 'public' | 'private';
type Who = 'visitor' | 'outsider' | SpaceRoleName;

const WHO: Who[] = [
  'visitor',
  'outsider',
  'solver',
  'observer',
  'editor',
  'administrator',
  'owner',
];
const MEMBERS: Who[] = ['solver', 'observer', 'editor', 'administrator', 'owner'];
const READERS: Who[] = ['observer', 'editor', 'administrator', 'owner'];
const WRITERS: Who[] = ['editor', 'administrator', 'owner'];

function build(who: Who, visibility: Visibility, archived: boolean, extra: Partial<Resource> = {}) {
  const actor: Actor = who === 'visitor' ? null : user;
  const role = who === 'visitor' || who === 'outsider' ? null : who;
  return { actor, resource: { space: { visibility, archived, role }, ...extra } as Resource };
}

function allowed(
  action: Action,
  who: Who,
  visibility: Visibility,
  archived: boolean,
  extra: Partial<Resource> = {}
) {
  const { actor, resource } = build(who, visibility, archived, extra);
  return can(actor, action, resource);
}

/** Roles that are allowed, for one Space state. */
function expectOnly(
  action: Action,
  visibility: Visibility,
  archived: boolean,
  expected: Who[],
  extra: Partial<Resource> = {}
) {
  for (const who of WHO) {
    expect({
      action,
      who,
      visibility,
      archived,
      result: allowed(action, who, visibility, archived, extra),
    }).toEqual({
      action,
      who,
      visibility,
      archived,
      result: expected.includes(who),
    });
  }
}

describe('can()', () => {
  it('covers every action in the table below', () => {
    expect(ACTIONS).toHaveLength(16);
  });

  describe('space.view', () => {
    it.each([false, true])('public Space is visible to everyone (archived=%s)', (archived) => {
      expectOnly('space.view', 'public', archived, WHO);
    });
    it.each([false, true])('private Space is for members only (archived=%s)', (archived) => {
      expectOnly('space.view', 'private', archived, MEMBERS);
    });
  });

  describe('space.view_members', () => {
    it.each(['public', 'private'] as Visibility[])('members only in a %s Space', (visibility) => {
      expectOnly('space.view_members', visibility, false, MEMBERS);
    });
  });

  describe.each(['space.update', 'space.manage_members'] as Action[])('%s', (action) => {
    it.each(['public', 'private'] as Visibility[])(
      'owner and administrator in a %s Space',
      (visibility) => {
        expectOnly(action, visibility, false, ['administrator', 'owner']);
      }
    );
    it.each(['public', 'private'] as Visibility[])(
      'nobody once a %s Space is archived',
      (visibility) => {
        expectOnly(action, visibility, true, []);
      }
    );
  });

  describe.each([
    'space.change_visibility',
    'space.archive',
    'space.transfer_ownership',
  ] as Action[])('%s (the dangerous ones)', (action) => {
    it.each(['public', 'private'] as Visibility[])('owner only in a %s Space', (visibility) => {
      expectOnly(action, visibility, false, ['owner']);
    });
    it.each(['public', 'private'] as Visibility[])(
      'nobody once a %s Space is archived',
      (visibility) => {
        expectOnly(action, visibility, true, []);
      }
    );
  });

  describe('space.leave', () => {
    it.each([false, true])('any member but the owner, even when archived=%s', (archived) => {
      const leavers: Who[] = ['solver', 'observer', 'editor', 'administrator'];
      expectOnly('space.leave', 'public', archived, leavers);
      expectOnly('space.leave', 'private', archived, leavers);
    });
  });

  describe('problem.view', () => {
    it('published problems follow Space visibility', () => {
      expectOnly('problem.view', 'public', false, WHO, { problemStatus: 'published' });
      expectOnly('problem.view', 'public', true, WHO, { problemStatus: 'published' });
      expectOnly('problem.view', 'private', false, MEMBERS, { problemStatus: 'published' });
    });
    it('drafts are for the people who can read the editor view', () => {
      expectOnly('problem.view', 'public', false, READERS, { problemStatus: 'draft' });
      expectOnly('problem.view', 'private', false, READERS, { problemStatus: 'draft' });
    });
  });

  describe('problem.view_private (hidden tests, reference solutions, editor view)', () => {
    it.each(['public', 'private'] as Visibility[])(
      'owner, administrator, editor and observer in a %s Space',
      (visibility) => {
        expectOnly('problem.view_private', visibility, false, READERS);
      }
    );
    it.each(['public', 'private'] as Visibility[])(
      'still readable by them once a %s Space is archived',
      (visibility) => {
        expectOnly('problem.view_private', visibility, true, READERS);
      }
    );
  });

  describe.each(['problem.create', 'problem.update', 'problem.publish'] as Action[])(
    '%s',
    (action) => {
      it.each(['public', 'private'] as Visibility[])(
        'owner, administrator and editor in a %s Space; the observer changes nothing',
        (visibility) => {
          expectOnly(action, visibility, false, WRITERS);
        }
      );
      it.each(['public', 'private'] as Visibility[])(
        'nobody once a %s Space is archived',
        (visibility) => {
          expectOnly(action, visibility, true, []);
        }
      );
    }
  );

  describe('submission.create', () => {
    it('public Space: any logged-in user, never a visitor', () => {
      expectOnly('submission.create', 'public', false, [
        'outsider',
        'solver',
        'observer',
        'editor',
        'administrator',
        'owner',
      ]);
    });
    it('private Space: members only', () => {
      expectOnly('submission.create', 'private', false, MEMBERS);
    });
    it.each(['public', 'private'] as Visibility[])(
      'nobody in an archived %s Space',
      (visibility) => {
        expectOnly('submission.create', visibility, true, []);
      }
    );
  });

  describe('submission.view', () => {
    const someoneElse = { submissionAuthorId: 'user-2' };
    const mine = { submissionAuthorId: 'user-1' };

    it('own submissions: anyone logged in who can see the Space', () => {
      expectOnly('submission.view', 'public', false, ['outsider', ...MEMBERS], mine);
      expectOnly('submission.view', 'private', false, MEMBERS, mine);
    });
    it("other people's submissions: owner, administrator, editor and observer", () => {
      expectOnly('submission.view', 'public', false, READERS, someoneElse);
      expectOnly('submission.view', 'private', false, READERS, someoneElse);
    });
    it('archived Spaces keep submissions readable', () => {
      expectOnly('submission.view', 'public', true, READERS, someoneElse);
    });
  });

  describe('submission.view_all (the Space-wide submission list, GRD-93)', () => {
    it.each(['public', 'private'] as Visibility[])(
      'owner, administrator, editor and observer in a %s Space',
      (visibility) => {
        expectOnly('submission.view_all', visibility, false, READERS);
        expectOnly('submission.view_all', visibility, true, READERS);
      }
    );
  });
});

describe('canAssignRole() and canRemoveMember() (GRD-96)', () => {
  const ROLES: SpaceRoleName[] = ['owner', 'administrator', 'editor', 'observer', 'solver'];

  it('the owner can invite or move anyone else to any role; ownership moves by handover', () => {
    for (const from of [null, 'administrator', 'editor', 'observer', 'solver'] as const) {
      for (const to of ROLES) expect(canAssignRole('owner', from, to)).toBe(true);
    }
    expect(canAssignRole('owner', 'owner', 'editor')).toBe(false);
  });

  it('an administrator manages editors, observers and solvers only', () => {
    for (const from of [null, 'editor', 'observer', 'solver'] as const) {
      expect(canAssignRole('administrator', from, 'editor')).toBe(true);
      expect(canAssignRole('administrator', from, 'observer')).toBe(true);
      expect(canAssignRole('administrator', from, 'solver')).toBe(true);
      expect(canAssignRole('administrator', from, 'administrator')).toBe(false);
      expect(canAssignRole('administrator', from, 'owner')).toBe(false);
    }
    expect(canAssignRole('administrator', 'administrator', 'editor')).toBe(false);
    expect(canAssignRole('administrator', 'owner', 'editor')).toBe(false);
  });

  it('nobody else assigns roles', () => {
    for (const actor of ['editor', 'observer', 'solver', null] as const) {
      for (const to of ROLES) expect(canAssignRole(actor, null, to)).toBe(false);
    }
  });

  it('removal follows the same ladder; the owner is never removed', () => {
    expect(ROLES.map((role) => canRemoveMember('owner', role))).toEqual([
      false,
      true,
      true,
      true,
      true,
    ]);
    expect(ROLES.map((role) => canRemoveMember('administrator', role))).toEqual([
      false,
      false,
      true,
      true,
      true,
    ]);
    for (const actor of ['editor', 'observer', 'solver', null] as const) {
      for (const role of ROLES) expect(canRemoveMember(actor, role)).toBe(false);
    }
  });
});
