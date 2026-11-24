import { randomBytes } from 'node:crypto';
import type { Clock } from '../../common/time/clock.js';
import type { Env } from '../../config/env.schema.js';
import { LocalObjectStorage } from './local-object-storage.js';
import type { ObjectStorage } from './object-storage.js';
import { createR2Client, R2ObjectStorage } from './r2-object-storage.js';

type StorageEnv = Pick<
  Env,
  | 'STORAGE_DRIVER'
  | 'STORAGE_LOCAL_DIR'
  | 'STORAGE_LOCAL_BASE_URL'
  | 'PORT'
  | 'R2_ENDPOINT'
  | 'R2_ACCESS_KEY_ID'
  | 'R2_SECRET_ACCESS_KEY'
  | 'R2_BUCKET'
  | 'R2_PUBLIC_BUCKET'
  | 'R2_PUBLIC_BASE_URL'
>;

/** The server's own disk, for development, tests and the demo. */
export function createLocalStorage(env: StorageEnv, clock: Clock): LocalObjectStorage {
  return new LocalObjectStorage(
    env.STORAGE_LOCAL_DIR,
    env.STORAGE_LOCAL_BASE_URL ?? `http://localhost:${env.PORT}`,
    randomBytes(32),
    clock,
  );
}

/**
 * The store the settings name. R2 needs its settings (the schema refuses a start without them; this refuses too, so a
 * test that skips the schema cannot quietly fall back to the disk).
 */
export function createObjectStorage(env: StorageEnv, clock: Clock): ObjectStorage {
  if (env.STORAGE_DRIVER !== 'r2') return createLocalStorage(env, clock);
  const { R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET, R2_PUBLIC_BASE_URL } =
    env;
  if (
    !R2_ENDPOINT ||
    !R2_ACCESS_KEY_ID ||
    !R2_SECRET_ACCESS_KEY ||
    !R2_BUCKET ||
    !R2_PUBLIC_BASE_URL
  ) {
    throw new Error('STORAGE_DRIVER=r2 needs the R2 settings');
  }
  return new R2ObjectStorage(
    createR2Client({
      endpoint: R2_ENDPOINT,
      accessKeyId: R2_ACCESS_KEY_ID,
      secretAccessKey: R2_SECRET_ACCESS_KEY,
    }),
    {
      privateBucket: R2_BUCKET,
      publicBucket: env.R2_PUBLIC_BUCKET ?? R2_BUCKET,
      publicBaseUrl: R2_PUBLIC_BASE_URL.replace(/\/+$/, ''),
    },
    clock,
  );
}
