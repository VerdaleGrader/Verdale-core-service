import type { FastifyReply, FastifyRequest } from 'fastify';
import { requireUser } from '@/middleware/session';
import CollectionService from '@/services/catalog/collection.service';
import TrackMemberService from '@/services/catalog/track-member.service';
import TrackService from '@/services/catalog/track.service';
import {
  catalogListQuery,
  collectionParams,
  createCollectionBody,
  createTrackBody,
  createTrackInviteBody,
  patchCollectionProblemsBody,
  reorderTracksBody,
  setCollectionProblemsBody,
  setTrackCollectionsBody,
  slugParams,
  trackInviteParams,
  trackMemberParams,
  trackParams,
  updateCollectionBody,
  updateTrackBody,
} from '@/validation/schemas';

/** Tracks, Collections and Track membership (GRD-77 to GRD-82). */
export default class CatalogController {
  constructor(
    private readonly tracks: TrackService,
    private readonly collections: CollectionService,
    private readonly trackMembers: TrackMemberService
  ) {}

  // --- tracks -------------------------------------------------------------

  /** GET /api/v1/spaces/:slug/tracks */
  async listTracks(request: FastifyRequest, reply: FastifyReply) {
    const { slug } = slugParams.parse(request.params);
    const { include_archived } = catalogListQuery.parse(request.query);
    return reply.send({
      items: await this.tracks.list(request.currentUser, slug, {
        includeArchived: include_archived,
      }),
    });
  }

  /** POST /api/v1/spaces/:slug/tracks */
  async createTrack(request: FastifyRequest, reply: FastifyReply) {
    const user = requireUser(request);
    const { slug } = slugParams.parse(request.params);
    const track = await this.tracks.create(
      user,
      slug,
      createTrackBody.parse(request.body),
      request.id
    );
    return reply.status(201).send(track);
  }

  /** PUT /api/v1/spaces/:slug/tracks/order */
  async reorderTracks(request: FastifyRequest, reply: FastifyReply) {
    const user = requireUser(request);
    const { slug } = slugParams.parse(request.params);
    const { track_slugs } = reorderTracksBody.parse(request.body);
    return reply.send({ items: await this.tracks.reorder(user, slug, track_slugs, request.id) });
  }

  /** GET /api/v1/spaces/:slug/tracks/:trackSlug */
  async getTrack(request: FastifyRequest, reply: FastifyReply) {
    const { slug, trackSlug } = trackParams.parse(request.params);
    return reply.send(await this.tracks.get(request.currentUser, slug, trackSlug));
  }

  /** PATCH /api/v1/spaces/:slug/tracks/:trackSlug */
  async updateTrack(request: FastifyRequest, reply: FastifyReply) {
    const user = requireUser(request);
    const { slug, trackSlug } = trackParams.parse(request.params);
    return reply.send(
      await this.tracks.update(
        user,
        slug,
        trackSlug,
        updateTrackBody.parse(request.body),
        request.id
      )
    );
  }

  /** DELETE /api/v1/spaces/:slug/tracks/:trackSlug: archives it. */
  async archiveTrack(request: FastifyRequest, reply: FastifyReply) {
    const user = requireUser(request);
    const { slug, trackSlug } = trackParams.parse(request.params);
    await this.tracks.archive(user, slug, trackSlug, request.id);
    return reply.status(204).send();
  }

  /** PUT /api/v1/spaces/:slug/tracks/:trackSlug/collections */
  async setTrackCollections(request: FastifyRequest, reply: FastifyReply) {
    const user = requireUser(request);
    const { slug, trackSlug } = trackParams.parse(request.params);
    const { collection_slugs } = setTrackCollectionsBody.parse(request.body);
    await this.tracks.setCollections(user, slug, trackSlug, collection_slugs, request.id);
    return reply.send(await this.tracks.get(user, slug, trackSlug));
  }

  /** GET /api/v1/spaces/:slug/tracks/:trackSlug/progress: staff only. */
  async trackProgress(request: FastifyRequest, reply: FastifyReply) {
    const user = requireUser(request);
    const { slug, trackSlug } = trackParams.parse(request.params);
    return reply.send(await this.tracks.memberProgress(user, slug, trackSlug));
  }

  // --- collections --------------------------------------------------------

  /** GET /api/v1/spaces/:slug/collections */
  async listCollections(request: FastifyRequest, reply: FastifyReply) {
    const { slug } = slugParams.parse(request.params);
    const { include_archived } = catalogListQuery.parse(request.query);
    return reply.send({
      items: await this.collections.list(request.currentUser, slug, {
        includeArchived: include_archived,
      }),
    });
  }

  /** POST /api/v1/spaces/:slug/collections */
  async createCollection(request: FastifyRequest, reply: FastifyReply) {
    const user = requireUser(request);
    const { slug } = slugParams.parse(request.params);
    const collection = await this.collections.create(
      user,
      slug,
      createCollectionBody.parse(request.body),
      request.id
    );
    return reply.status(201).send(collection);
  }

  /** GET /api/v1/spaces/:slug/collections/:collectionSlug */
  async getCollection(request: FastifyRequest, reply: FastifyReply) {
    const { slug, collectionSlug } = collectionParams.parse(request.params);
    return reply.send(await this.collections.get(request.currentUser, slug, collectionSlug));
  }

  /** PATCH /api/v1/spaces/:slug/collections/:collectionSlug */
  async updateCollection(request: FastifyRequest, reply: FastifyReply) {
    const user = requireUser(request);
    const { slug, collectionSlug } = collectionParams.parse(request.params);
    return reply.send(
      await this.collections.update(
        user,
        slug,
        collectionSlug,
        updateCollectionBody.parse(request.body),
        request.id
      )
    );
  }

  /** DELETE /api/v1/spaces/:slug/collections/:collectionSlug: archives it. */
  async archiveCollection(request: FastifyRequest, reply: FastifyReply) {
    const user = requireUser(request);
    const { slug, collectionSlug } = collectionParams.parse(request.params);
    await this.collections.archive(user, slug, collectionSlug, request.id);
    return reply.status(204).send();
  }

  /** PUT /api/v1/spaces/:slug/collections/:collectionSlug/problems: the whole ordered list. */
  async setCollectionProblems(request: FastifyRequest, reply: FastifyReply) {
    const user = requireUser(request);
    const { slug, collectionSlug } = collectionParams.parse(request.params);
    const { problem_slugs } = setCollectionProblemsBody.parse(request.body);
    await this.collections.setProblems(user, slug, collectionSlug, problem_slugs, request.id);
    return reply.send(await this.collections.get(user, slug, collectionSlug));
  }

  /** PATCH /api/v1/spaces/:slug/collections/:collectionSlug/problems: add and remove several at once. */
  async patchCollectionProblems(request: FastifyRequest, reply: FastifyReply) {
    const user = requireUser(request);
    const { slug, collectionSlug } = collectionParams.parse(request.params);
    await this.collections.patchProblems(
      user,
      slug,
      collectionSlug,
      patchCollectionProblemsBody.parse(request.body),
      request.id
    );
    return reply.send(await this.collections.get(user, slug, collectionSlug));
  }

  // --- Track members and invitations --------------------------------------

  /** GET /api/v1/spaces/:slug/tracks/:trackSlug/members */
  async listTrackMembers(request: FastifyRequest, reply: FastifyReply) {
    const user = requireUser(request);
    const { slug, trackSlug } = trackParams.parse(request.params);
    return reply.send({ items: await this.trackMembers.list(user, slug, trackSlug) });
  }

  /** DELETE /api/v1/spaces/:slug/tracks/:trackSlug/members/:username */
  async removeTrackMember(request: FastifyRequest, reply: FastifyReply) {
    const user = requireUser(request);
    const { slug, trackSlug, username } = trackMemberParams.parse(request.params);
    await this.trackMembers.remove(user, slug, trackSlug, username, request.id);
    return reply.status(204).send();
  }

  /** GET /api/v1/spaces/:slug/tracks/:trackSlug/invites */
  async listTrackInvites(request: FastifyRequest, reply: FastifyReply) {
    const user = requireUser(request);
    const { slug, trackSlug } = trackParams.parse(request.params);
    return reply.send({ items: await this.trackMembers.listInvites(user, slug, trackSlug) });
  }

  /** POST /api/v1/spaces/:slug/tracks/:trackSlug/invites */
  async createTrackInvite(request: FastifyRequest, reply: FastifyReply) {
    const user = requireUser(request);
    const { slug, trackSlug } = trackParams.parse(request.params);
    const invite = await this.trackMembers.createInvite(
      user,
      slug,
      trackSlug,
      createTrackInviteBody.parse(request.body),
      request.id
    );
    return reply.status(201).send(invite);
  }

  /** DELETE /api/v1/spaces/:slug/tracks/:trackSlug/invites/:inviteId */
  async revokeTrackInvite(request: FastifyRequest, reply: FastifyReply) {
    const user = requireUser(request);
    const { slug, trackSlug, inviteId } = trackInviteParams.parse(request.params);
    await this.trackMembers.revokeInvite(user, slug, trackSlug, inviteId, request.id);
    return reply.status(204).send();
  }
}
