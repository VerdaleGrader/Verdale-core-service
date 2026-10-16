# Platform administration (GRD-58)

Tools for the people who run the platform, to stop harm at once on a public
site: report a problem, take a problem down, stop a person from sending code,
suspend an account or a Space, and read who did what. There is no screen for it
yet (an endpoint or the command line was enough for this card); the API is in
`contracts/core-public.openapi.yaml`, tag `platform`.

## The role

`users.platform_role` is `user` (everybody) or `admin`. It has nothing to do
with the roles in a Space: an owner of a Space is not an administrator and an
administrator needs no role in a Space.

**Giving it.** Only on the command line, by someone who can run a command on the
Core machine (or against its database):

```bash
npm run platform:grant -- <username>     # in a container: node build/src/cli/platform-admin.js grant <username>
npm run platform:revoke -- <username>
npm run platform:list
```

There is no API that changes it, so no request, and no Space owner, can make an
administrator. Each grant and revoke is written to the audit log with no actor
(`data.via = "command line"`). Revoke the role when someone leaves; the
administrators' accounts are the ones to protect with the strongest sign-in.

**Everybody else sees nothing.** Every `/api/v1/admin/*` route answers `404` to
a signed-in person who is not an administrator (and `401` to a visitor): the admin
API does not announce itself. A suspended administrator is refused like anyone else.
An administrator cannot be suspended through the API (`409 CANNOT_SUSPEND_ADMIN`):
take the role away first.

## What an administrator can do

| Action              | Call                                                                        | Effect                                                                                                                                                                      | Undo                     |
| ------------------- | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| Read the reports    | `GET /admin/reports?status=open`                                            | Open ones oldest first; resolved ones newest first                                                                                                                          |                          |
| Close a report      | `POST /admin/reports/{id}/resolve` `{outcome: dismissed or actioned, note}` | Records who, when and a note; once only (`409 REPORT_RESOLVED`)                                                                                                             |                          |
| Take a problem down | `POST /admin/spaces/{slug}/problems/{problem}/unpublish` `{reason}`         | Solvers, outsiders and visitors get `404`; submissions refused; leaves every list; the Space's staff still see it; the authors cannot publish, update, archive or delete it | `.../restore`            |
| Suspend a Space     | `POST /admin/spaces/{slug}/suspend` `{reason}`                              | Closed to everybody: members `403 SPACE_SUSPENDED`, others `404`; out of the public list and its members' lists; nothing deleted                                            | `.../restore`            |
| Suspend an account  | `POST /admin/users/{username}/suspend` `{reason}`                           | Every call but `GET /me` and `/auth/*` answers `403 ACCOUNT_SUSPENDED` with the reason; checked on every request, so it is immediate                                        | `.../restore`            |
| Stop only the code  | `POST /admin/users/{username}/suspend-submissions` `{reason}`               | New submissions and re-checks answer `403 SUBMISSIONS_SUSPENDED`; submissions already sent are judged; the rest works                                                       | `.../resume-submissions` |
| Read the audit log  | `GET /admin/audit-log?target_type&target_id&actor`                          | Newest first                                                                                                                                                                |                          |

Every action needs a reason (3 to 500 characters), is recorded, and can be undone. Nothing is deleted:
a taken-down problem keeps its tests, versions and submissions.

## Reports

Any signed-in person who can open a problem reports it with `POST /spaces/{slug}/problems/{problem}/report`
(`reason` up to 1000 characters, `category`: `abuse`, `copyright`, `cheating`, `other`). A problem they cannot see
is `404`; asking again while a report is open is `409 ALREADY_REPORTED`; at most 5 reports a minute per person.
The reporter learns nothing about what happens next: the administrator's note stays between administrators.

## The audit log

`platform_audit_logs`: who (`actor_id`; null for the command line), what (`action`), to what (`target_type`,
`target_id`, `target_label` = the slug or username as it was), the reason (`data`), and when. It has no foreign
key to the object, so it survives the deletion of a user, a Space or a problem. Entries are written in the same
transaction as the change: a change without an entry cannot happen, and an action that was refused leaves nothing.

Actions: `admin.granted`, `admin.revoked`, `report.resolved`, `problem.unpublished`, `problem.restored`,
`space.suspended`, `space.restored`, `user.suspended`, `user.restored`, `user.submissions_suspended`,
`user.submissions_resumed`.

## How a problem is taken down

`problems.suspended_at` is set and `status` goes back to `draft`; the published version is not touched. Everything
solver-facing already treats a draft as not existing, so the one change closes every door (reading, submitting, the
lists, the progress). The authors cannot undo it: publishing needs a verified version, and a published version is
immutable. Restoring puts `published` back. See `docs/decisions.md` (2026-10-17).

## What is not done

- **No screen.** The web app has no page for reports or for these actions yet; the contract is ready for one.
- **Process, not tooling:** who reads the reports, how quickly, and what is told to a person whose account was suspended
  (the message shows the reason the administrator typed). Needs a decision by the team that runs the platform.
- **Invitations to a suspended Space** can still be opened and accepted; the person then meets the suspension.
- **No automatic action** on repeated reports; an administrator decides.
