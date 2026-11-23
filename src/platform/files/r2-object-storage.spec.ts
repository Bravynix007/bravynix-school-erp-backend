import {
  DeleteObjectCommand,
  GetObjectCommand,
  NoSuchKey,
  type S3Client,
} from '@aws-sdk/client-s3';
import { FixedClock } from '../../common/time/clock.js';
import { MAX_FILE_BYTES } from './file-purposes.js';
import { createR2Client, R2ObjectStorage } from './r2-object-storage.js';

const clock = new FixedClock();
const buckets = {
  privateBucket: 'priv',
  publicBucket: 'pub',
  publicBaseUrl: 'https://cdn.example.test',
};
const client = createR2Client({
  endpoint: 'https://acct.r2.cloudflarestorage.com',
  accessKeyId: 'AKID',
  secretAccessKey: 'SECRET',
});
const storage = new R2ObjectStorage(client, buckets, clock);
const in5Minutes = () => new Date(clock.now().getTime() + 300_000);
const PUBLIC_KEY = 'public/s1/i1/10/abc';
const PRIVATE_KEY = 's1/i1/3/abc';

const ticket = (key: string) =>
  storage.createUpload({
    key,
    contentType: 'image/png',
    sizeBytes: 1234,
    maxBytes: MAX_FILE_BYTES,
    expiresAt: in5Minutes(),
  });

const answering = (send: (command: unknown) => Promise<unknown>) => {
  const spy = vi.fn<(command: unknown) => Promise<unknown>>(send);
  return {
    spy,
    store: new R2ObjectStorage({ send: spy } as unknown as S3Client, buckets, clock),
  };
};

describe('R2ObjectStorage', () => {
  describe('createUpload', () => {
    it('is a presigned PUT, signed for the type, the exact size and "only if nothing is there"', async () => {
      const { url, method, headers, fields, expiresAt } = await ticket(PUBLIC_KEY);
      const address = new URL(url);
      expect(method).toBe('PUT');
      expect(fields).toEqual({});
      expect(headers).toEqual({
        'content-type': 'image/png',
        'content-length': '1234',
        'if-none-match': '*',
      });
      expect(address.searchParams.get('X-Amz-SignedHeaders')).toBe(
        'content-length;content-type;host;if-none-match',
      );
      expect(address.searchParams.get('X-Amz-Expires')).toBe('300');
      expect(expiresAt).toEqual(in5Minutes());
    });

    it('has no checksum of an empty body in it, which R2 would hold against the real file', async () => {
      const { url } = await ticket(PUBLIC_KEY);
      expect([...new URL(url).searchParams.keys()].join()).not.toMatch(/checksum/i);
    });

    it('goes to the public bucket for a public key and the private one for the rest', async () => {
      expect(new URL((await ticket(PUBLIC_KEY)).url).pathname).toBe(`/pub/${PUBLIC_KEY}`);
      expect(new URL((await ticket(PRIVATE_KEY)).url).pathname).toBe(`/priv/${PRIVATE_KEY}`);
    });

    it('never carries the secret key', async () => {
      expect((await ticket(PUBLIC_KEY)).url).not.toContain('SECRET');
    });
  });

  it('createDownload is a five-minute link that offers the file as an attachment of a fixed type', async () => {
    const { url } = await storage.createDownload({
      key: PRIVATE_KEY,
      contentType: 'application/pdf',
      fileName: 'Report "1".pdf',
      expiresAt: in5Minutes(),
    });
    const address = new URL(url);
    expect(address.pathname).toBe(`/priv/${PRIVATE_KEY}`);
    expect(address.searchParams.get('response-content-type')).toBe('application/pdf');
    expect(address.searchParams.get('response-content-disposition')).toBe(
      'attachment; filename="Report _1_.pdf"',
    );
    expect(address.searchParams.get('X-Amz-Expires')).toBe('300');
  });

  it('publicUrl is the public address and the key', () => {
    expect(storage.publicUrl(PUBLIC_KEY)).toBe(`https://cdn.example.test/${PUBLIC_KEY}`);
  });

  describe('with the bucket answering', () => {
    it('read asks for at most one byte past the largest file and returns what came', async () => {
      const { spy, store } = answering(() =>
        Promise.resolve({
          Body: { transformToByteArray: () => Promise.resolve(Uint8Array.of(1, 2, 3)) },
        }),
      );
      expect(await store.read(PRIVATE_KEY)).toEqual(Buffer.of(1, 2, 3));
      const command = spy.mock.calls[0]![0] as GetObjectCommand;
      expect(command).toBeInstanceOf(GetObjectCommand);
      expect(command.input).toMatchObject({
        Bucket: 'priv',
        Key: PRIVATE_KEY,
        Range: `bytes=0-${MAX_FILE_BYTES}`,
      });
    });

    it('read answers null when nothing is stored, and passes any other fault on', async () => {
      const gone = answering(() =>
        Promise.reject(new NoSuchKey({ message: 'no key', $metadata: {} })),
      );
      expect(await gone.store.read(PUBLIC_KEY)).toBeNull();
      const down = answering(() => Promise.reject(new Error('R2 is down')));
      await expect(down.store.read(PUBLIC_KEY)).rejects.toThrow('R2 is down');
    });

    it('remove deletes the object from the bucket its key belongs to', async () => {
      const { spy, store } = answering(() => Promise.resolve({}));
      await store.remove(PUBLIC_KEY);
      const command = spy.mock.calls[0]![0] as DeleteObjectCommand;
      expect(command).toBeInstanceOf(DeleteObjectCommand);
      expect(command.input).toMatchObject({ Bucket: 'pub', Key: PUBLIC_KEY });
    });
  });
});
