import { FastifyReply, FastifyRequest } from 'fastify';
import SystemService from '@/services/system/system.service';

export default class SystemController {
  constructor(private readonly systemService: SystemService) {}

  /** GET /health: liveness. */
  async health(_request: FastifyRequest, reply: FastifyReply) {
    return reply.send(this.systemService.getHealth());
  }

  /** GET /ready: readiness, checks the database. */
  async ready(request: FastifyRequest, reply: FastifyReply) {
    const readiness = await this.systemService.getReadiness(request.id);
    return reply.status(readiness.status === 'ready' ? 200 : 503).send(readiness);
  }
}
