import { AppException, type FieldError } from '../../src/common/http/app-exception.js';
import { createValidationPipe } from '../../src/common/validation/validation.js';

const pipe = createValidationPipe();

/** A request body run through the same validation pipe the API uses. */
export const body = <T>(metatype: new () => T, value: unknown) =>
  pipe.transform(value, { type: 'body', metatype }) as Promise<T>;

/** The field problems a validation answered with, empty when the value passed. */
export async function problems(
  work: Promise<unknown>,
): Promise<Pick<FieldError, 'field' | 'code'>[]> {
  try {
    await work;
  } catch (error) {
    if (error instanceof AppException) {
      return (error.options.errors ?? []).map(({ field, code }) => ({ field, code }));
    }
    throw error;
  }
  return [];
}
