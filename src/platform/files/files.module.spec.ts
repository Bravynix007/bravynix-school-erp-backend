import type { MiddlewareConsumer } from '@nestjs/common';
import { FixedClock } from '../../common/time/clock.js';
import { FilesModule } from './files.module.js';
import { LocalObjectStorage } from './local-object-storage.js';
import { R2ObjectStorage } from './r2-object-storage.js';

const consumerOf = () => {
  const forRoutes = vi.fn<(routes: unknown) => void>();
  const apply = vi
    .fn<(middleware: unknown) => { forRoutes: typeof forRoutes }>()
    .mockReturnValue({ forRoutes });
  return { consumer: { apply } as unknown as MiddlewareConsumer, apply, forRoutes };
};

describe('FilesModule', () => {
  const clock = new FixedClock();

  it('mounts the addresses of the local disk for the local disk', () => {
    const { consumer, apply, forRoutes } = consumerOf();
    const local = new LocalObjectStorage(
      '/tmp/erp-module-test',
      'http://api.test',
      Buffer.alloc(32),
      clock,
    );
    new FilesModule(local).configure(consumer);
    expect(apply).toHaveBeenCalledOnce();
    expect(forRoutes).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'local-storage/*address' }),
    );
  });

  it('mounts nothing for R2, which serves its own addresses', () => {
    const { consumer, apply } = consumerOf();
    const r2 = new R2ObjectStorage(
      {} as never,
      { privateBucket: 'a', publicBucket: 'a', publicBaseUrl: 'https://cdn.test' },
      clock,
    );
    new FilesModule(r2).configure(consumer);
    expect(apply).not.toHaveBeenCalled();
  });
});
