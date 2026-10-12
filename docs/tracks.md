# Tracks, Collections and what solvers can reach (Milestone 3)

How problems are grouped and who sees which. API details live in `contracts/core-public.openapi.yaml`; the permission table is in [auth.md](auth.md).

## The shape

```
space ─< track ─< track_collection >─ collection ─< collection_problem >─ problem
              └─< track_member >─ user
```

- **Track**: a path through problems inside a Space. Name, slug (unique in the Space), description, order (`position`), privacy, `archived_at`.
- **Collection**: a set of problems (name, slug unique in the Space, description). It can sit in **several Tracks** (each with its own order) or in **none**; a problem can be in **several Collections**. Links carry a 1-based `position`.
- **Privacy** has two levels: `space` (everyone who can see the Space sees the Track) and `members` (only people added to the Track). Owners and editors always see every Track. In a public Space a visitor sees `space` Tracks; a private Space is invisible to outsiders whatever its Tracks say.
- Every Space starts with a Track **General** (`general`), renamable; `POST /spaces` takes `track_name` for the starter Track. The migration gave every existing Space one, and put its existing problems in a Collection `general` inside it, so nothing a solver could see before disappeared.
- A Collection or Track is never deleted by the API: it is **archived** (hidden from solvers, restorable). Removing a problem from a Collection, or a Collection from a Track, deletes only the link.

Rules the database enforces (migration `add_tracks_and_collections`): slug format and uniqueness, positions start at 1, a Track and its Collections and a Collection and its problems are in the **same Space** (triggers), only a **member of the Space** can be a Track member (trigger), and a Track invitation can only be a `solver` seat (`invites_track_is_solver`). `src/services/track/*.test.ts` tests each of them.

## What solvers see (GRD-81)

Solvers, logged-in outsiders of a public Space, and visitors are treated alike: a problem exists for them only if it is **published** and sits in a Collection (not archived) of a Track they can see (not archived; open to the Space, or they were added to it). A Collection in several Tracks is visible when **any** of them is. The staff (owner, administrator, editor, observer) need none of this and see every Track, Collection and problem.

| Call                                              | Outside every visible Track                                                                        |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `GET …/problems` (list)                           | not listed                                                                                         |
| `GET …/problems/{slug}`, its PDF                  | 404, the same answer as for a problem that does not exist                                          |
| `POST …/submissions`                              | 404                                                                                                |
| `GET …/submissions` (own history)                 | still answered **if the person submitted to it before**, otherwise 404 (so slugs cannot be probed) |
| `GET /submissions/{id}`                           | unchanged: author and the staff                                                                    |
| `GET …/collections/{slug}`, `GET …/tracks/{slug}` | 404 unless visible as above; solvers get published problems only, never drafts                     |

The rule lives in one place for each shape: `can()` (`problem.view`, `submission.create`, `track.view` take `problemInTrack` / `track` facts), `TrackRepository.isProblemInVisibleTrack` for one problem and `problemInVisibleTrackWhere` for listings. Taking a problem out of its last Track therefore hides it and closes submissions, while leaving the history readable.

## Reordering

Every order change sends the **whole set** (`track_ids`, `collection_ids`, `problem_ids`). The server answers 409 `ORDER_MISMATCH` and changes nothing if the list misses, repeats or invents an item, so two people reordering at once cannot interleave into a half-order. Adding several items in one request appends them in the order given; removing ignores items that are not there.

## Members and invitations (GRD-80)

A Track invitation is a row in `invites` with `track_id` set, so previews, links, expiry, revocation, "my invitations" and the 410 rules are the Space's own. Differences: it always carries `role = solver`; accepting it adds the person to the Space **as a solver if they are not a member yet** and to the Track; someone who is already in the Space keeps the role they have (an invitation never raises a role); an archived Track or Space makes it 410. Space invitation lists do not show Track invitations and the reverse.

Removing someone from a Track takes only the Track membership; removing someone from the Space, or leaving it, removes their Track memberships in the same transaction. Inviting, revoking, joining and removing are written to `audit_logs` (`track.invite_created`, `track.invite_revoked`, `track.member_joined`, `track.member_removed`) with the actor and the Track.

## Progression (GRD-82)

A problem counts as **passed** when the person has at least one AC on it, on **any version**, so editing a problem later never takes progress away. Only **published** problems count, and a problem taken out of a Collection or Track leaves the denominator (and its AC leaves the numerator; it is back if the problem is). At Track level a problem in two Collections counts once; at Collection level it counts in each. `GET …/tracks/{slug}/progress` is the caller's; the staff (observers included, `track.view_progress`) may add `?username=` for a member, and `…/progress/members` lists every solver who can see the Track. Managing (`track.manage`, `track.manage_members`) is for owners, administrators and editors.

## The Track a submission came from (GRD-93)

`POST …/submissions` takes an optional `track` (slug). It must be a Track that reaches the problem through a Collection that is not archived, and that the person may see (staff: any active Track); otherwise 400. Left out, the submission is attributed to the first such Track in order, or to none when staff submit to a problem that sits in no Track. It is stored as `submissions.track_id` (set to null if the Track is ever deleted; archiving keeps it) and is what the Space-wide submission pages group by.

## PDF statements (GRD-73)

A problem version has a **statement mode**, `markdown` or `pdf`, frozen with the version. `PUT …/statement/pdf` (multipart `file`) checks, from the bytes: starts with `%PDF-`, at most 10 MiB, at most 10 pages, not encrypted. The page count comes from `pdf-lib` **in a worker thread with a 5 second budget** because a PDF padded with junk can keep the parser busy for tens of seconds (measured: 9 MB of trailing bytes, 33 s); a file that cannot be checked in time is refused as "too complex to check". The file is stored in the **private bucket** at `statements/<sha256>` and is served only through `GET …/statement/pdf`, which applies the same permission as reading the problem and sends `application/pdf`, `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'; sandbox`, `Cross-Origin-Resource-Policy: same-origin` and `Cache-Control: private`. Switching back to Markdown keeps the uploaded file. Sample tests are separate in both modes. In PDF mode the publish checklist wants the PDF instead of text.

## Profile (GRD-68)

`users.avatar_url` is the provider's picture (https, at most 2048 characters, no credentials in the URL; anything else is stored as null), refreshed at every login; a login that brings no picture keeps the old one. `PATCH /me` changes the display name (1 to 64 characters, no control characters or line separators, Thai and emoji welcome) at most 10 times a minute per person. Usernames stay as M2 made them. There is no picture upload in the MVP.
