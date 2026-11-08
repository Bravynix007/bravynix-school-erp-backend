import { randomBytes } from 'node:crypto';
import { Module, RequestMethod, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { Clock } from '../../common/time/clock.js';
import { AppConfig } from '../../config/app-config.js';
import { FilesController } from './files.controller.js';
import { FilesRepository } from './files.repository.js';
import { FilesService } from './files.service.js';
import { LocalObjectStorage, LOCAL_STORAGE_PATH } from './local-object-storage.js';
import { localStorageMiddleware } from './local-storage.middleware.js';
import { ObjectStorage } from './object-storage.js';

/**
 * Files (SDD 10.7, API design 15). Storage is the local disk for now; the signed addresses it hands out are served
 * by `localStorageMiddleware`, which stands in for S3 until the deployment slice adds the real driver.
 */
@Module({
  providers: [
    FilesRepository,
    FilesService,
    {
      provide: LocalObjectStorage,
      inject: [AppConfig, Clock],
      useFactory: ({ env }: AppConfig, clock: Clock) => {
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
      },
    },
    { provide: ObjectStorage, useExisting: LocalObjectStorage },
  ],
  controllers: [FilesController],
  exports: [FilesService],
})
export class FilesModule implements NestModule {
  constructor(private readonly storage: LocalObjectStorage) {}

  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(localStorageMiddleware(this.storage))
      .forRoutes({ path: `${LOCAL_STORAGE_PATH.slice(1)}/:token`, method: RequestMethod.ALL });
  }
}
