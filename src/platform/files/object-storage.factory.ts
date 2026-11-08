import { randomBytes } from 'node:crypto';
import type { Clock } from '../../common/time/clock.js';
import type { Env } from '../../config/env.schema.js';
import { LocalObjectStorage } from './local-object-storage.js';

/**
 * The store the settings name. Only the local disk has a driver; `r2` is refused here so that a staging or
 * production deploy set to it cannot go on quietly writing to the server's disk. It stops refusing when the
 * deployment slice adds the driver.
 */
export function createLocalStorage(
  env: Pick<Env, 'STORAGE_DRIVER' | 'STORAGE_LOCAL_DIR' | 'STORAGE_LOCAL_BASE_URL' | 'PORT'>,
  clock: Clock,
): LocalObjectStorage {
  if (env.STORAGE_DRIVER !== 'local') {
    throw new Error(
      `STORAGE_DRIVER=${env.STORAGE_DRIVER} has no driver yet: it arrives with the deployment slice`,
    );
  }
  return new LocalObjectStorage(
    env.STORAGE_LOCAL_DIR,
    env.STORAGE_LOCAL_BASE_URL ?? `http://localhost:${env.PORT}`,
    randomBytes(32),
    clock,
  );
}
