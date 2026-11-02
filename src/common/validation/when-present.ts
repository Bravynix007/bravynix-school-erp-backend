import { ValidateIf } from 'class-validator';

/**
 * Checks a field only when it is sent. A change may leave a field out, but naming it `null` is refused (400
 * `INVALID_TYPE`), because the field can never be empty. `@IsOptional` is for the fields `null` clears: it
 * would let `null` through to the database.
 */
export const WhenPresent = () => ValidateIf((_dto, value: unknown) => value !== undefined);
