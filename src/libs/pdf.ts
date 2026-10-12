import { Worker } from 'node:worker_threads';

/** Why a file was refused as a statement; the message is shown to the author. */
export class PdfRejectedError extends Error {}

const HEADER = Buffer.from('%PDF-');

/** A well-formed PDF is read in milliseconds; this only stops hostile files. */
export const PDF_CHECK_TIMEOUT_MS = 5_000;

/**
 * A real PDF starts with "%PDF-" (readers tolerate a little junk before it, so
 * we look in the first KiB, as the format allows). The file name and the
 * declared content type are never trusted.
 */
export function hasPdfHeader(bytes: Buffer): boolean {
  return bytes.subarray(0, 1024).includes(HEADER);
}

/**
 * Runs in a worker thread. pdf-lib parses in the thread that calls it, and a
 * file padded with junk can keep it busy for tens of seconds (measured: 9 MB of
 * trailing bytes took 33 s). In a worker the check can be stopped on time and
 * cannot stall the API.
 */
const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
(async () => {
  try {
    const { PDFDocument } = require(workerData.library);
    const document = await PDFDocument.load(workerData.bytes, {
      ignoreEncryption: false,
      throwOnInvalidObject: true,
      updateMetadata: false,
    });
    parentPort.postMessage({ pages: document.getPageCount() });
  } catch (error) {
    parentPort.postMessage({ failure: error && error.constructor ? error.constructor.name : 'Error' });
  }
})();
`;

/**
 * Reads the page count. Refuses what cannot be parsed, what is encrypted (it
 * could not be shown without a password), and what takes too long to check.
 * The file is already capped in size by the caller.
 */
export async function countPdfPages(
  bytes: Buffer,
  timeoutMs: number = PDF_CHECK_TIMEOUT_MS
): Promise<number> {
  if (!hasPdfHeader(bytes)) throw new PdfRejectedError('is not a PDF file');
  return new Promise<number>((resolve, reject) => {
    const worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: { bytes, library: require.resolve('pdf-lib') },
      resourceLimits: { maxOldGenerationSizeMb: 256 },
    });
    let settled = false;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      action();
    };
    const timer = setTimeout(
      () => finish(() => reject(new PdfRejectedError('is too complex to check'))),
      timeoutMs
    );
    worker.once('message', (message: { pages?: number; failure?: string }) => {
      finish(() => {
        if (typeof message.pages === 'number') resolve(message.pages);
        else if (message.failure === 'EncryptedPDFError') {
          reject(new PdfRejectedError('is encrypted or password-protected'));
        } else reject(new PdfRejectedError('is damaged or not a valid PDF'));
      });
    });
    worker.once('error', () =>
      finish(() => reject(new PdfRejectedError('is damaged or not a valid PDF')))
    );
    worker.once('exit', () =>
      finish(() => reject(new PdfRejectedError('is damaged or not a valid PDF')))
    );
  });
}
