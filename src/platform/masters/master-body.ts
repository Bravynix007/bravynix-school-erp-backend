import { createValidationPipe } from '../../common/validation/validation.js';

const pipe = createValidationPipe();

/**
 * Validates a body against the DTO of the master the path names. The global pipe
 * cannot, because one route serves seven masters; this is the same pipe, so the
 * field errors are the ones every other endpoint answers (API design 8).
 */
export async function parseMasterBody(dto: new () => object, body: unknown): Promise<object> {
  return (await pipe.transform(body, { type: 'body', metatype: dto })) as object;
}
