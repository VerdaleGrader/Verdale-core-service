import { sniffImageType } from '@/libs/image-type';

describe('sniffImageType', () => {
  it('recognises png, jpeg and webp from their first bytes', () => {
    expect(sniffImageType(Buffer.from('89504e470d0a1a0a0000', 'hex'))).toBe('image/png');
    expect(sniffImageType(Buffer.from('ffd8ffe000104a464946', 'hex'))).toBe('image/jpeg');
    expect(
      sniffImageType(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')]))
    ).toBe('image/webp');
  });

  it('refuses everything else, whatever it claims to be', () => {
    expect(sniffImageType(Buffer.from('GIF89a......'))).toBeNull();
    expect(sniffImageType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
    expect(sniffImageType(Buffer.from('<html><script>alert(1)</script>'))).toBeNull();
    expect(sniffImageType(Buffer.from('RIFF....WAVEfmt '))).toBeNull();
    expect(sniffImageType(Buffer.alloc(0))).toBeNull();
    expect(sniffImageType(Buffer.from([0x89, 0x50]))).toBeNull();
  });
});
