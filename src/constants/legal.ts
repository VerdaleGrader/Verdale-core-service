/**
 * The version of each legal document that users must have accepted (GRD-122).
 *
 * This is the ONE place to change when a document is republished: a version is
 * the document's effective date (YYYY-MM-DD) as printed at the end of the
 * document. After the change, every user whose latest accepted version differs
 * is turned away with 403 LEGAL_ACCEPTANCE_REQUIRED until they accept again
 * (the web app shows the full-page notice at /accept-terms).
 *
 * Keep it in step with the Frontend's content/legal/*.md and lib/legal.ts. The
 * accept endpoint compares the versions the page showed with these, so a stale
 * page can never record a version the user did not see.
 */
import type { LegalDocument } from '../../generated/prisma/enums';

export const LEGAL_DOCUMENTS: readonly LegalDocument[] = ['terms', 'privacy'];

export const CURRENT_LEGAL_VERSIONS: Readonly<Record<LegalDocument, string>> = {
  terms: '2026-10-13',
  privacy: '2026-10-13',
};
