import { Module, RequestMethod, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { Clock } from '../../common/time/clock.js';
import { AppConfig } from '../../config/app-config.js';
import { FileDirectory } from './file-directory.js';
import { FilesController } from './files.controller.js';
import { FilesRepository } from './files.repository.js';
import { FilesService } from './files.service.js';
import { LocalObjectStorage, LOCAL_STORAGE_PATH } from './local-object-storage.js';
import { localStorageMiddleware } from './local-storage.middleware.js';
import { createObjectStorage } from './object-storage.factory.js';
import { ObjectStorage } from './object-storage.js';

/**
 * Files (SDD 10.7, API design 15). Storage is the local disk in development, tests and the demo, and R2 when
 * `STORAGE_DRIVER=r2`. The addresses the local disk hands out are served by `localStorageMiddleware`, which stands
 * in for R2 and is mounted only for it.
 */
@Module({
  providers: [
    FilesRepository,
    FilesService,
    FileDirectory,
    {
      provide: ObjectStorage,
      inject: [AppConfig, Clock],
      useFactory: ({ env }: AppConfig, clock: Clock) => createObjectStorage(env, clock),
    },
  ],
  controllers: [FilesController],
  exports: [FilesService, FileDirectory, ObjectStorage],
})
export class FilesModule implements NestModule {
  constructor(private readonly storage: ObjectStorage) {}

  configure(consumer: MiddlewareConsumer): void {
    if (!(this.storage instanceof LocalObjectStorage)) return;
    consumer
      .apply(localStorageMiddleware(this.storage))
      .forRoutes({ path: `${LOCAL_STORAGE_PATH.slice(1)}/*address`, method: RequestMethod.ALL });
  }
}
