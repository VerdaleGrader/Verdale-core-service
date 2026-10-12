import type { FastifyReply, FastifyRequest } from 'fastify';
import { requireUser } from '@/middleware/session';
import InviteService from '@/services/space/invite.service';
import CollectionService from '@/services/track/collection.service';
import ProgressService from '@/services/track/progress.service';
import TrackMemberService from '@/services/track/track-member.service';
import TrackService from '@/services/track/track.service';
import {
  collectionParams,
  collectionSlugsBody,
  createCollectionBody,
  createTrackBody,
  createTrackInviteBody,
  problemSlugsBody,
  progressQuery,
  reorderCollectionsBody,
  reorderProblemsBody,
  reorderTracksBody,
  slugParams,
  trackInviteParams,
  trackMemberParams,
  trackParams,
  updateCollectionBody,
  updateTrackBody,
} from '@/validation/schemas';

/** Tracks, their Collections, their members and invitations, and progress (GRD-77 to GRD-82). */
export default class TrackController {
  constructor(
    private readonly trackService: TrackService,
    private readonly collectionService: CollectionService,
    private readonly memberService: TrackMemberService,
    private readonly inviteService: InviteService,
    private readonly progressService: ProgressService
  ) {}

  // --- tracks -------------------------------------------------------------

  /** GET /api/v1/spaces/:slug/tracks */
  async list(request: FastifyRequest, reply: FastifyReply) {
    const { slug } = slugParams.parse(request.params);
    return reply.send(await this.trackService.list(request.currentUser, slug));
  }

  /** POST /api/v1/spaces/:slug/tracks */
  async create(request: FastifyRequest, reply: FastifyReply) {
    const user = requireUser(request);
    const { slug } = slugParams.parse(request.params);
    const track = await this.trackService.create(
      user,
      slug,
      createTrackBody.parse(request.body),
      request.id
    );
    return reply.status(201).send(track);
  }

  /** POST /api/v1/spaces/:slug/tracks/reorder */
  async reorder(request: FastifyRequest, reply: FastifyReply) {
    const user = requireUser(request);
    const { slug } = slugParams.parse(request.params);
    const { track_ids } = reorderTracksBody.parse(request.body);
    return reply.send(await this.trackService.reorder(user, slug, track_ids, request.id));
  }

  /** GET /api/v1/spaces/:slug/tracks/:trackSlug */
  async get(request: FastifyRequest, reply: FastifyReply) {
    const { slug, trackSlug } = trackParams.parse(request.params);
    return reply.send(await this.trackService.get(request.currentUser, slug, trackSlug));
  }

  /** PATCH /api/v1/spaces/:slug/tracks/:trackSlug */
  async update(request: FastifyRequest, reply: FastifyReply) {
    const user = requireUser(request);
    const { slug, trackSlug } = trackParams.parse(request.params);
    return reply.send(
      await this.trackService.update(
        user,
        slug,
        trackSlug,
        updateTrackBody.parse(request.body),
        request.id
      )
    );
  }

  /** POST /api/v1/spaces/:slug/tracks/:trackSlug/archive */
  async archive(request: FastifyRequest, reply: FastifyReply) {
    const user = requireUser(request);
    const { slug, trackSlug } = trackParams.parse(request.params);
    return reply.send(await this.trackService.archive(user, slug, trackSlug, request.id));
  }

  /** POST /api/v1/spaces/:slug/tracks/:trackSlug/restore */
  async restore(request: FastifyRequest, reply: FastifyReply) {
    const user = requireUser(request);
    const { slug, trackSlug } = trackParams.parse(request.params);
    return reply.send(await this.trackService.restore(user, slug, trackSlug, request.id));
  }

  // --- Collections inside a Track ----------------------------------------

  /** POST /api/v1/spaces/:slug/tracks/:trackSlug/collections */
  async addCollections(request: FastifyRequest, reply: FastifyReply) {
    const user = requireUser(request);
    const { slug, trackSlug } = trackParams.parse(request.params);
    const { collection_slugs } = collectionSlugsBody.parse(request.body);
    return reply.send(
      await this.collectionService.addToTrack(user, slug, trackSlug, collection_slugs, request.id)
    );
  }

  /** POST /api/v1/spaces/:slug/tracks/:trackSlug/collections/remove */
  async removeCollections(request: FastifyRequest, reply: FastifyReply) {
    const user = requireUser(request);
    const { slug, trackSlug } = trackParams.parse(request.params);
    const { collection_slugs } = collectionSlugsBody.parse(request.body);
    return reply.send(
      await this.collectionService.removeFromTrack(
        user,
        slug,
        trackSlug,
        collection_slugs,
        request.id
      )
    );
  }

  /** POST /api/v1/spaces/:slug/tracks/:trackSlug/collections/reorder */
  async reorderCollections(request: FastifyRequest, reply: FastifyReply) {
    const user = requireUser(request);
    const { slug, trackSlug } = trackParams.parse(request.params);
    const { collection_ids } = reorderCollectionsBody.parse(request.body);
    return reply.send(
      await this.collectionService.reorderInTrack(user, slug, trackSlug, collection_ids, request.id)
    );
  }

  // --- members and invitations -------------------------------------------

  /** GET /api/v1/spaces/:slug/tracks/:trackSlug/members */
  async listMembers(request: FastifyRequest, reply: FastifyReply) {
    const user = requireUser(request);
    const { slug, trackSlug } = trackParams.parse(request.params);
    return reply.send(await this.memberService.list(user, slug, trackSlug));
  }

  /** DELETE /api/v1/spaces/:slug/tracks/:trackSlug/members/:username */
  async removeMember(request: FastifyRequest, reply: FastifyReply) {
    const user = requireUser(request);
    const { slug, trackSlug, username } = trackMemberParams.parse(request.params);
    await this.memberService.remove(user, slug, trackSlug, username, request.id);
    return reply.status(204).send();
  }

  /** GET /api/v1/spaces/:slug/tracks/:trackSlug/invites */
  async listInvites(request: FastifyRequest, reply: FastifyReply) {
    const user = requireUser(request);
    const { slug, trackSlug } = trackParams.parse(request.params);
    return reply.send({ items: await this.inviteService.listForTrack(user, slug, trackSlug) });
  }

  /** POST /api/v1/spaces/:slug/tracks/:trackSlug/invites */
  async createInvite(request: FastifyRequest, reply: FastifyReply) {
    const user = requireUser(request);
    const { slug, trackSlug } = trackParams.parse(request.params);
    const invite = await this.inviteService.createForTrack(
      user,
      slug,
      trackSlug,
      createTrackInviteBody.parse(request.body ?? {}),
      request.id
    );
    return reply.status(201).send(invite);
  }

  /** DELETE /api/v1/spaces/:slug/tracks/:trackSlug/invites/:inviteId: revoke. */
  async revokeInvite(request: FastifyRequest, reply: FastifyReply) {
    const user = requireUser(request);
    const { slug, trackSlug, inviteId } = trackInviteParams.parse(request.params);
    await this.inviteService.revokeForTrack(user, slug, trackSlug, inviteId, request.id);
    return reply.status(204).send();
  }

  // --- progress -----------------------------------------------------------

  /** GET /api/v1/spaces/:slug/tracks/:trackSlug/progress?username= */
  async progress(request: FastifyRequest, reply: FastifyReply) {
    const user = requireUser(request);
    const { slug, trackSlug } = trackParams.parse(request.params);
    const { username } = progressQuery.parse(request.query);
    return reply.send(await this.progressService.forUser(user, slug, trackSlug, username));
  }

  /** GET /api/v1/spaces/:slug/tracks/:trackSlug/progress/members */
  async memberProgress(request: FastifyRequest, reply: FastifyReply) {
    const user = requireUser(request);
    const { slug, trackSlug } = trackParams.parse(request.params);
    return reply.send(await this.progressService.forMembers(user, slug, trackSlug));
  }
}

/** Collections of a Space: the sets of problems that Tracks are made of (GRD-79). */
export class CollectionController {
  constructor(private readonly collectionService: CollectionService) {}

  /** GET /api/v1/spaces/:slug/collections (owners and editors) */
  async list(request: FastifyRequest, reply: FastifyReply) {
    const { slug } = slugParams.parse(request.params);
    return reply.send(await this.collectionService.list(request.currentUser, slug));
  }

  /** POST /api/v1/spaces/:slug/collections */
  async create(request: FastifyRequest, reply: FastifyReply) {
    const user = requireUser(request);
    const { slug } = slugParams.parse(request.params);
    const collection = await this.collectionService.create(
      user,
      slug,
      createCollectionBody.parse(request.body),
      request.id
    );
    return reply.status(201).send(collection);
  }

  /** GET /api/v1/spaces/:slug/collections/:collectionSlug */
  async get(request: FastifyRequest, reply: FastifyReply) {
    const { slug, collectionSlug } = collectionParams.parse(request.params);
    return reply.send(await this.collectionService.get(request.currentUser, slug, collectionSlug));
  }

  /** PATCH /api/v1/spaces/:slug/collections/:collectionSlug */
  async update(request: FastifyRequest, reply: FastifyReply) {
    const user = requireUser(request);
    const { slug, collectionSlug } = collectionParams.parse(request.params);
    return reply.send(
      await this.collectionService.update(
        user,
        slug,
        collectionSlug,
        updateCollectionBody.parse(request.body),
        request.id
      )
    );
  }

  /** POST /api/v1/spaces/:slug/collections/:collectionSlug/archive */
  async archive(request: FastifyRequest, reply: FastifyReply) {
    const user = requireUser(request);
    const { slug, collectionSlug } = collectionParams.parse(request.params);
    return reply.send(await this.collectionService.archive(user, slug, collectionSlug, request.id));
  }

  /** POST /api/v1/spaces/:slug/collections/:collectionSlug/restore */
  async restore(request: FastifyRequest, reply: FastifyReply) {
    const user = requireUser(request);
    const { slug, collectionSlug } = collectionParams.parse(request.params);
    return reply.send(await this.collectionService.restore(user, slug, collectionSlug, request.id));
  }

  /** POST /api/v1/spaces/:slug/collections/:collectionSlug/problems */
  async addProblems(request: FastifyRequest, reply: FastifyReply) {
    const user = requireUser(request);
    const { slug, collectionSlug } = collectionParams.parse(request.params);
    const { problem_slugs } = problemSlugsBody.parse(request.body);
    return reply.send(
      await this.collectionService.addProblems(
        user,
        slug,
        collectionSlug,
        problem_slugs,
        request.id
      )
    );
  }

  /** POST /api/v1/spaces/:slug/collections/:collectionSlug/problems/remove */
  async removeProblems(request: FastifyRequest, reply: FastifyReply) {
    const user = requireUser(request);
    const { slug, collectionSlug } = collectionParams.parse(request.params);
    const { problem_slugs } = problemSlugsBody.parse(request.body);
    return reply.send(
      await this.collectionService.removeProblems(
        user,
        slug,
        collectionSlug,
        problem_slugs,
        request.id
      )
    );
  }

  /** POST /api/v1/spaces/:slug/collections/:collectionSlug/problems/reorder */
  async reorderProblems(request: FastifyRequest, reply: FastifyReply) {
    const user = requireUser(request);
    const { slug, collectionSlug } = collectionParams.parse(request.params);
    const { problem_ids } = reorderProblemsBody.parse(request.body);
    return reply.send(
      await this.collectionService.reorderProblems(
        user,
        slug,
        collectionSlug,
        problem_ids,
        request.id
      )
    );
  }
}
