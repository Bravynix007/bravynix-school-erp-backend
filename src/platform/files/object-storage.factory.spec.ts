import { FixedClock } from '../../common/time/clock.js';
import { LocalObjectStorage } from './local-object-storage.js';
import { createLocalStorage, createObjectStorage } from './object-storage.factory.js';
import { R2ObjectStorage } from './r2-object-storage.js';

const env = {
  STORAGE_DRIVER: 'local' as const,
  STORAGE_LOCAL_DIR: '/tmp/erp-factory-test',
  STORAGE_LOCAL_BASE_URL: undefined,
  PORT: 3000,
  R2_ENDPOINT: undefined,
  R2_ACCESS_KEY_ID: undefined,
  R2_SECRET_ACCESS_KEY: undefined,
  R2_BUCKET: undefined,
  R2_PUBLIC_BUCKET: undefined,
  R2_PUBLIC_BASE_URL: undefined,
};
const r2 = {
  ...env,
  STORAGE_DRIVER: 'r2' as const,
  R2_ENDPOINT: 'https://acct.r2.cloudflarestorage.com',
  R2_ACCESS_KEY_ID: 'AKID',
  R2_SECRET_ACCESS_KEY: 'SECRET',
  R2_BUCKET: 'bucket',
  R2_PUBLIC_BASE_URL: 'https://cdn.example.test/',
};

describe('createLocalStorage', () => {
  it('gives the local disk', () => {
    expect(createLocalStorage(env, new FixedClock())).toBeInstanceOf(LocalObjectStorage);
  });
});

const upload = (settings: Parameters<typeof createObjectStorage>[0], key: string) =>
  createObjectStorage(settings, new FixedClock()).createUpload({
    key,
    contentType: 'image/png',
    sizeBytes: 5,
    maxBytes: 10,
    expiresAt: new Date(new FixedClock().now().getTime() + 60_000),
  });

describe('createObjectStorage', () => {
  const clock = new FixedClock();

  it('is the local disk for the local driver', () => {
    expect(createObjectStorage(env, clock)).toBeInstanceOf(LocalObjectStorage);
  });

  it('is R2 for the r2 driver, with the public address cleaned of its trailing slash', () => {
    const storage = createObjectStorage(r2, clock);
    expect(storage).toBeInstanceOf(R2ObjectStorage);
    expect(storage.publicUrl('public/a')).toBe('https://cdn.example.test/public/a');
  });

  it('keeps public images in R2_PUBLIC_BUCKET when one is named, and in the one bucket when not', async () => {
    const named = { ...r2, R2_PUBLIC_BUCKET: 'images' };
    expect((await upload(named, 'public/a')).url).toContain('/images/public/a');
    expect((await upload(named, 's/i/3/a')).url).toContain('/bucket/s/i/3/a');
    expect((await upload(r2, 'public/a')).url).toContain('/bucket/public/a');
  });

  it('refuses r2 without its settings, so a deploy cannot quietly use the server disk', () => {
    expect(() => createObjectStorage({ ...r2, R2_BUCKET: undefined }, clock)).toThrow(
      'STORAGE_DRIVER=r2 needs the R2 settings',
    );
  });
});
