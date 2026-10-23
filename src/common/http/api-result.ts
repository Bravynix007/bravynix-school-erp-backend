import { HttpStatus } from '@nestjs/common';
import { ResultCode } from './error-codes.js';

export interface PageMeta {
  page: number;
  limit: number;
  totalItems: number;
  totalPages: number;
}

export interface CursorMeta {
  limit: number;
  nextCursor: string | null;
  hasMore: boolean;
}

export type ListMeta = PageMeta | CursorMeta;

/** The response envelope every endpoint returns (API design 7.1). */
export interface ApiEnvelope<T = unknown> {
  success: boolean;
  statusCode: number;
  code: string;
  message: string;
  data: T | null;
  meta: ListMeta | null;
  errors?: { field: string; code: string; message: string; params?: Record<string, unknown> }[];
  requestId: string;
  [extra: string]: unknown;
}

/**
 * What a controller returns when it needs more than plain data: a named
 * result code, a non-200 status, a custom message or list meta. Plain
 * return values are wrapped as `200 OK`.
 */
export class ApiResult<T> {
  constructor(
    readonly data: T,
    readonly options: {
      status?: HttpStatus;
      code?: string;
      message?: string;
      meta?: ListMeta | null;
    } = {},
  ) {}

  static ok<T>(data: T, code: string = ResultCode.OK, message?: string): ApiResult<T> {
    return new ApiResult(data, { status: HttpStatus.OK, code, message });
  }

  static created<T>(data: T, code: string = ResultCode.CREATED, message?: string): ApiResult<T> {
    return new ApiResult(data, { status: HttpStatus.CREATED, code, message });
  }

  static accepted<T>(data: T, code: string = ResultCode.ACCEPTED, message?: string): ApiResult<T> {
    return new ApiResult(data, { status: HttpStatus.ACCEPTED, code, message });
  }

  static list<T>(items: T[], meta: ListMeta | null): ApiResult<T[]> {
    return new ApiResult(items, { status: HttpStatus.OK, code: ResultCode.OK, meta });
  }
}
