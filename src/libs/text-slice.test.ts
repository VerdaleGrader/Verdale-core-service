import { sliceString, sliceText } from '@/libs/text-slice';

const options = { maxLines: 3, maxLineChars: 20 };

describe('sliceText', () => {
  it('returns the first lines and the total', async () => {
    const slice = await sliceString('a\nb\nc\nd\ne\n', options);
    expect(slice).toEqual({
      lines: ['a', 'b', 'c'],
      from_line: 1,
      to_line: 3,
      total_lines: 5,
      size_bytes: 10,
      line_truncated: false,
    });
  });

  it('pages: from_line moves the window', async () => {
    const slice = await sliceString('a\nb\nc\nd\ne\n', { ...options, fromLine: 4 });
    expect(slice).toMatchObject({ lines: ['d', 'e'], from_line: 4, to_line: 5, total_lines: 5 });
  });

  it('a window past the end is empty but still reports the total', async () => {
    const slice = await sliceString('a\nb\n', { ...options, fromLine: 10 });
    expect(slice).toMatchObject({ lines: [], from_line: 10, to_line: 9, total_lines: 2 });
  });

  it('counts a last line that has no line break', async () => {
    expect((await sliceString('a\nb', options)).total_lines).toBe(2);
    expect((await sliceString('a\nb', options)).lines).toEqual(['a', 'b']);
    expect((await sliceString('a\nb', { ...options, fromLine: 2 })).lines).toEqual(['b']);
    expect((await sliceString('a\nb\n', options)).total_lines).toBe(2);
  });

  it('counts a last line outside the window too', async () => {
    const slice = await sliceString('1\n2\n3\n4\n5', options);
    expect(slice.total_lines).toBe(5);
    expect(slice.lines).toEqual(['1', '2', '3']);
  });

  it('an empty text has no lines; a lone line break is one empty line', async () => {
    expect(await sliceString('', options)).toMatchObject({
      lines: [],
      total_lines: 0,
      size_bytes: 0,
    });
    expect(await sliceString('\n', options)).toMatchObject({ lines: [''], total_lines: 1 });
    expect(await sliceString('\n\n', options)).toMatchObject({ lines: ['', ''], total_lines: 2 });
  });

  it('drops the CR of a CRLF but keeps a lone CR inside a line', async () => {
    const slice = await sliceString('a\r\nb\rc\r\n', options);
    expect(slice.lines).toEqual(['a', 'b\rc']);
    expect(slice.total_lines).toBe(2);
  });

  it('cuts very long lines and says so, without losing the count', async () => {
    const long = 'x'.repeat(100);
    const slice = await sliceString(`${long}\nshort\n${long}`, options);
    expect(slice.lines).toEqual(['x'.repeat(20), 'short', 'x'.repeat(20)]);
    expect(slice.line_truncated).toBe(true);
    expect(slice.total_lines).toBe(3);
    expect(slice.size_bytes).toBe(100 + 1 + 5 + 1 + 100);
  });

  it('does not keep text of lines outside the window', async () => {
    const huge = 'y'.repeat(5_000_000);
    const slice = await sliceString(`${huge}\n${huge}\nwanted\n`, {
      ...options,
      fromLine: 3,
      maxLines: 1,
    });
    expect(slice.lines).toEqual(['wanted']);
    expect(slice.line_truncated).toBe(false);
  });

  it('reads byte chunks, also when a character is split between two chunks', async () => {
    const bytes = Buffer.from('สวัสดี\nhello\n', 'utf8');
    const chunks = Array.from({ length: bytes.length }, (_, index) =>
      bytes.subarray(index, index + 1)
    );
    const slice = await sliceText(chunks, options);
    expect(slice.lines).toEqual(['สวัสดี', 'hello']);
    expect(slice.size_bytes).toBe(bytes.length);
  });

  it('turns broken UTF-8 into replacement characters', async () => {
    const slice = await sliceText([Buffer.from([0x61, 0xff, 0x62, 0x0a])], options);
    expect(slice.lines).toEqual(['a�b']);
  });

  it('works on an async stream', async () => {
    async function* chunks() {
      yield Buffer.from('a\nb');
      yield Buffer.from('c\nd\n');
    }
    const slice = await sliceText(chunks(), options);
    expect(slice.lines).toEqual(['a', 'bc', 'd']);
    expect(slice.total_lines).toBe(3);
  });
});
