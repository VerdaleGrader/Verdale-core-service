import type { PrismaClient } from '../../../generated/prisma/client';
import type { LegalDocument } from '../../../generated/prisma/enums';
import { CURRENT_LEGAL_VERSIONS, LEGAL_DOCUMENTS } from '@/constants/legal';
import { ConflictError, VError } from '@/errors';
import { Db } from '@/repositories/db';
import LegalRepository from '@/repositories/legal.repository';

export type LegalVersions = Record<LegalDocument, string>;

/** What the web app needs to know about the caller's acceptance. */
export interface LegalStatus {
  acceptance_required: boolean;
  current_versions: LegalVersions;
}

/** Thrown for every API call of a signed-in user who has not accepted the current documents. */
export class LegalAcceptanceRequiredError extends VError {
  constructor() {
    super({
      message: 'Please accept the updated Terms and Privacy Policy to continue.',
      status: 403,
      error_code: 'LEGAL_ACCEPTANCE_REQUIRED',
    });
  }
}

const currentPairs = (): Array<[LegalDocument, string]> =>
  LEGAL_DOCUMENTS.map((document) => [document, CURRENT_LEGAL_VERSIONS[document]]);

export default class LegalService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly legal: LegalRepository,
    private readonly now: () => Date = () => new Date()
  ) {}

  currentVersions(): LegalVersions {
    return { ...CURRENT_LEGAL_VERSIONS };
  }

  async hasAcceptedCurrent(userId: string): Promise<boolean> {
    const pairs = currentPairs();
    return (await this.legal.countAccepted(this.prisma, userId, pairs)) === pairs.length;
  }

  async status(userId: string): Promise<LegalStatus> {
    return {
      acceptance_required: !(await this.hasAcceptedCurrent(userId)),
      current_versions: this.currentVersions(),
    };
  }

  /** Part of the sign-up transaction: logging in the first time is accepting (the login page says so). */
  async recordCurrent(db: Db, userId: string): Promise<void> {
    await this.legal.record(db, userId, currentPairs(), this.now());
  }

  /**
   * The user pressed "accept" on a page that showed `shown`. Only the versions
   * that are current can be recorded, so a page left open across a republish
   * gets 409 and reloads instead of recording something the user did not read.
   */
  async accept(userId: string, shown: LegalVersions): Promise<LegalStatus> {
    const stale = LEGAL_DOCUMENTS.filter((d) => shown[d] !== CURRENT_LEGAL_VERSIONS[d]);
    if (stale.length > 0) {
      throw new ConflictError(
        'The Terms or Privacy Policy changed while this page was open. Reload the page and read the new version.',
        'LEGAL_VERSION_CHANGED'
      );
    }
    await this.legal.record(this.prisma, userId, currentPairs(), this.now());
    return this.status(userId);
  }
}
