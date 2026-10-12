import { ACTIONS, Action, Actor, Resource, SpaceRoleName, can } from '@/permissions/can';

const user: Actor = { userId: 'user-1' };
type Visibility = 'public' | 'private';
type Who = 'visitor' | 'outsider' | SpaceRoleName;

const WHO: Who[] = ['visitor', 'outsider', 'solver', 'editor', 'owner'];

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
    expect(ACTIONS).toHaveLength(13);
  });

  describe('space.view', () => {
    it.each([false, true])('public Space is visible to everyone (archived=%s)', (archived) => {
      expectOnly('space.view', 'public', archived, WHO);
    });
    it.each([false, true])('private Space is for members only (archived=%s)', (archived) => {
      expectOnly('space.view', 'private', archived, ['solver', 'editor', 'owner']);
    });
  });

  describe('space.view_members', () => {
    it.each(['public', 'private'] as Visibility[])('members only in a %s Space', (visibility) => {
      expectOnly('space.view_members', visibility, false, ['solver', 'editor', 'owner']);
    });
  });

  describe.each(['space.update', 'space.archive', 'space.manage_members'] as Action[])(
    '%s',
    (action) => {
      it.each(['public', 'private'] as Visibility[])('owner only in a %s Space', (visibility) => {
        expectOnly(action, visibility, false, ['owner']);
      });
      it.each(['public', 'private'] as Visibility[])(
        'nobody once a %s Space is archived',
        (visibility) => {
          expectOnly(action, visibility, true, []);
        }
      );
    }
  );

  describe('space.leave', () => {
    it.each([false, true])('any member, even when archived=%s', (archived) => {
      expectOnly('space.leave', 'public', archived, ['solver', 'editor', 'owner']);
      expectOnly('space.leave', 'private', archived, ['solver', 'editor', 'owner']);
    });
  });

  describe('problem.view', () => {
    it('published problems follow Space visibility', () => {
      expectOnly('problem.view', 'public', false, WHO, { problemStatus: 'published' });
      expectOnly('problem.view', 'public', true, WHO, { problemStatus: 'published' });
      expectOnly('problem.view', 'private', false, ['solver', 'editor', 'owner'], {
        problemStatus: 'published',
      });
    });
    it('drafts are for owners and editors only', () => {
      expectOnly('problem.view', 'public', false, ['editor', 'owner'], { problemStatus: 'draft' });
      expectOnly('problem.view', 'private', false, ['editor', 'owner'], { problemStatus: 'draft' });
    });
  });

  describe('problem.view_private (hidden tests, reference solutions, editor view)', () => {
    it.each(['public', 'private'] as Visibility[])(
      'owners and editors only in a %s Space',
      (visibility) => {
        expectOnly('problem.view_private', visibility, false, ['editor', 'owner']);
      }
    );
    it.each(['public', 'private'] as Visibility[])(
      'still readable by them once a %s Space is archived',
      (visibility) => {
        expectOnly('problem.view_private', visibility, true, ['editor', 'owner']);
      }
    );
  });

  describe.each(['problem.create', 'problem.update', 'problem.publish'] as Action[])(
    '%s',
    (action) => {
      it.each(['public', 'private'] as Visibility[])(
        'owners and editors in a %s Space',
        (visibility) => {
          expectOnly(action, visibility, false, ['editor', 'owner']);
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
      expectOnly('submission.create', 'public', false, ['outsider', 'solver', 'editor', 'owner']);
    });
    it('private Space: members only', () => {
      expectOnly('submission.create', 'private', false, ['solver', 'editor', 'owner']);
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
      expectOnly(
        'submission.view',
        'public',
        false,
        ['outsider', 'solver', 'editor', 'owner'],
        mine
      );
      expectOnly('submission.view', 'private', false, ['solver', 'editor', 'owner'], mine);
    });
    it("other people's submissions: owners and editors only", () => {
      expectOnly('submission.view', 'public', false, ['editor', 'owner'], someoneElse);
      expectOnly('submission.view', 'private', false, ['editor', 'owner'], someoneElse);
    });
    it('archived Spaces keep submissions readable', () => {
      expectOnly('submission.view', 'public', true, ['editor', 'owner'], someoneElse);
    });
  });
});
