import { Injectable, type PipeTransform } from '@nestjs/common';
import { AppException } from './app-exception.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A path ID that is not a UUID answers 404, like an unknown one: the caller
 * learns nothing about which IDs exist (API design 7.5, SDD 12.4).
 */
@Injectable()
export class UuidParamPipe implements PipeTransform<string, string> {
  transform(value: string): string {
    if (!UUID.test(value)) throw AppException.notFound();
    return value.toLowerCase();
  }
}
