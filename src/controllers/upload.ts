import '@fastify/multipart';
import type { FastifyRequest } from 'fastify';
import { BadRequestError, ValidationError } from '@/errors';
import { formatBytes } from '@/libs/test-file';

export interface ReadUploads {
  files: Record<string, { filename: string; bytes: Buffer }>;
  fields: Record<string, string>;
}

/**
 * Reads a multipart request into memory, with a size cap per file. A file over
 * the cap is reported against its own field, so the web app can show it next to
 * the right file. Files with other field names are read and dropped.
 */
export async function readUploads(
  request: FastifyRequest,
  options: { maxFileBytes: number; fileFields: string[]; fieldNames?: string[] }
): Promise<ReadUploads> {
  if (!request.isMultipart()) {
    throw new BadRequestError('Send the files as multipart/form-data.');
  }
  const result: ReadUploads = { files: {}, fields: {} };
  const parts = request.parts({
    limits: { fileSize: options.maxFileBytes, files: options.fileFields.length + 2, fields: 8 },
  });
  for await (const part of parts) {
    if (part.type === 'file') {
      let bytes: Buffer;
      try {
        bytes = await part.toBuffer();
      } catch (error) {
        if ((error as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE') {
          const label = part.filename ? `“${part.filename}”` : `The ${part.fieldname} file`;
          throw new ValidationError([
            {
              field: part.fieldname,
              message: `${label} is larger than ${formatBytes(options.maxFileBytes)}.`,
            },
          ]);
        }
        throw error;
      }
      if (options.fileFields.includes(part.fieldname)) {
        result.files[part.fieldname] = { filename: part.filename ?? '', bytes };
      }
    } else if (typeof part.value === 'string') {
      result.fields[part.fieldname] = part.value;
    }
  }
  return result;
}
