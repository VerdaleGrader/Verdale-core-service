import { createHash } from 'node:crypto';
import { TestFileError, formatBytes, normalizeTestFile } from '@/libs/test-file';

const limit = { maxBytes: 1024 };
const normalize = (text: string | Buffer) =>
  normalizeTestFile(Buffer.isBuffer(text) ? text : Buffer.from(text, 'utf8'), limit);
const text = (input: string | Buffer) => normalize(input).bytes.toString('utf8');

function reasonOf(input: Buffer | string, options = limit): TestFileError {
  try {
    normalizeTestFile(Buffer.isBuffer(input) ? input : Buffer.from(input, 'utf8'), options);
  } catch (error) {
    return error as TestFileError;
  }
  throw new Error('expected the file to be refused');
}

describe('normalizeTestFile (GRD-25)', () => {
  describe('line endings', () => {
    it('turns CRLF into LF', () => expect(text('1 2\r\n3 4\r\n')).toBe('1 2\n3 4\n'));
    it('turns a lone CR (old Mac) into LF', () => expect(text('1\r2\r')).toBe('1\n2\n'));
    it('keeps LF as it is', () => expect(text('a\nb\n')).toBe('a\nb\n'));
    it('handles a mix in one file', () => expect(text('a\r\nb\rc\nd')).toBe('a\nb\nc\nd\n'));
  });

  describe('end of file', () => {
    it('adds the missing final newline', () => expect(text('42')).toBe('42\n'));
    it('collapses several trailing newlines to one', () => expect(text('42\n\n\n')).toBe('42\n'));
    it('removes trailing blank lines written as CRLF', () =>
      expect(text('42\r\n\r\n\r\n')).toBe('42\n'));
    it('keeps blank lines in the middle', () => expect(text('a\n\nb\n')).toBe('a\n\nb\n'));
    it('keeps trailing spaces inside lines (an input may need them)', () =>
      expect(text('a  \nb \n')).toBe('a  \nb \n'));
    it('keeps leading blank lines', () => expect(text('\n\nx')).toBe('\n\nx\n'));
    it('an empty file stays empty', () => {
      const result = normalize('');
      expect(result.size).toBe(0);
      expect(result.bytes.length).toBe(0);
    });
    it('a file with only newlines becomes empty', () => expect(text('\n\r\n\n')).toBe(''));
  });

  describe('text encoding', () => {
    it('keeps UTF-8 text, including Thai and emoji', () =>
      expect(text('สวัสดี 🌍\n')).toBe('สวัสดี 🌍\n'));
    it('removes a leading byte order mark', () =>
      expect(text(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('7\n')]))).toBe(
        '7\n'
      ));
    it('keeps tabs', () => expect(text('a\tb\n')).toBe('a\tb\n'));
  });

  describe('binary files are refused', () => {
    it('rejects a NUL byte and says where', () => {
      const error = reasonOf(Buffer.from([0x31, 0x32, 0x00, 0x33]));
      expect(error.code).toBe('BINARY');
      expect(error.reason).toMatch(/NUL byte at offset 2/);
      expect(error.reason).toMatch(/binary/);
    });
    it('rejects other control characters', () => {
      const error = reasonOf(Buffer.from([0x61, 0x1b, 0x5b]));
      expect(error.code).toBe('BINARY');
      expect(error.reason).toMatch(/control character 0x1b at offset 1/);
    });
    it('rejects a PNG', () => {
      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
      expect(reasonOf(png).code).toBe('BINARY');
    });
    it('rejects bytes that are not valid UTF-8', () => {
      const error = reasonOf(Buffer.from([0x61, 0xff, 0xfe, 0x62]));
      expect(error.code).toBe('NOT_UTF8');
      expect(error.reason).toMatch(/not valid UTF-8/);
    });
    it('rejects Latin-1 text with accents', () => {
      expect(reasonOf(Buffer.from('café', 'latin1')).code).toBe('NOT_UTF8');
    });
    it('rejects a truncated multi-byte sequence', () => {
      expect(reasonOf(Buffer.from([0xe0, 0xb8])).code).toBe('NOT_UTF8');
    });
  });

  describe('size', () => {
    it('accepts a file exactly at the limit', () => {
      expect(normalizeTestFile(Buffer.from('a'.repeat(1023) + '\n'), limit).size).toBe(1024);
    });
    it('refuses a file over the limit before reading it', () => {
      const error = reasonOf(Buffer.alloc(1025, 0x61));
      expect(error.code).toBe('TOO_LARGE');
      expect(error.reason).toBe('is larger than 1 KiB');
    });
    it('measures the normalised size: a missing final newline can push it over', () => {
      expect(reasonOf(Buffer.from('a'.repeat(1024))).code).toBe('TOO_LARGE');
    });
    it('stores the normalised size: CRLF shrinks a file that was under the limit', () => {
      const crlf = Array(400).fill('x').join('\r\n'); // 1198 bytes raw
      expect(normalizeTestFile(Buffer.from(crlf), { maxBytes: 1300 }).size).toBe(800);
    });
    it('still refuses a file whose raw upload is over the limit (the upload itself is capped)', () => {
      const crlf = Array(600).fill('x').join('\r\n'); // 1798 bytes raw, 1200 normalised
      expect(reasonOf(Buffer.from(crlf), { maxBytes: 1300 }).code).toBe('TOO_LARGE');
    });
  });

  describe('hash', () => {
    it('is the SHA-256 of the normalised bytes, so line endings do not matter', () => {
      const crlf = normalize('1 2\r\n');
      const lf = normalize('1 2\n');
      const bare = normalize('1 2');
      expect(crlf.sha256).toBe(lf.sha256);
      expect(bare.sha256).toBe(lf.sha256);
      expect(lf.sha256).toBe(createHash('sha256').update('1 2\n').digest('hex'));
    });
    it('is the hash of zero bytes for an empty file', () => {
      expect(normalize('').sha256).toBe(
        'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
      );
    });
  });

  it('formats sizes for messages', () => {
    expect(formatBytes(512)).toBe('512 bytes');
    expect(formatBytes(2048)).toBe('2 KiB');
    expect(formatBytes(8 * 1024 * 1024)).toBe('8 MiB');
  });
});
