import { Injectable, type PipeTransform } from '@nestjs/common';
import { AppException } from '../../common/http/app-exception.js';
import { isMasterType, MASTER_SPECS, type MasterSpec } from './master.catalog.js';

/** The master the path names; an unknown name is 404, like an unknown ID (API design 7.5). */
@Injectable()
export class MasterTypePipe implements PipeTransform<string, MasterSpec> {
  transform(value: string): MasterSpec {
    if (!isMasterType(value)) throw AppException.notFound();
    return MASTER_SPECS[value];
  }
}
