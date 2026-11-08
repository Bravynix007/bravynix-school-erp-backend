import { FixedClock } from '../../common/time/clock.js';
import { LocalObjectStorage } from './local-object-storage.js';
import { createLocalStorage } from './object-storage.factory.js';

const env = {
  STORAGE_DRIVER: 'local' as const,
  STORAGE_LOCAL_DIR: '/tmp/erp-factory-test',
  STORAGE_LOCAL_BASE_URL: undefined,
  PORT: 3000,
};

describe('createLocalStorage', () => {
  it('gives the local disk for the local driver', () => {
    expect(createLocalStorage(env, new FixedClock())).toBeInstanceOf(LocalObjectStorage);
  });

  it('refuses r2, so a deploy set to it cannot quietly use the server disk', () => {
    expect(() => createLocalStorage({ ...env, STORAGE_DRIVER: 'r2' }, new FixedClock())).toThrow(
      /STORAGE_DRIVER=r2 has no driver yet/,
    );
  });
});
