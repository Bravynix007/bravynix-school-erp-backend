import { Transform } from 'class-transformer';

const lower = (item: unknown): unknown => (typeof item === 'string' ? item.toLowerCase() : item);

/**
 * A UUID, or each UUID of a list, in lower case before it is validated, as `UuidParamPipe` does for the path.
 * A UUID may be sent in either case (RFC 9562), but the database answers in lower case, so an ID compared with
 * what it returns (a lookup by ID, a repeat in a list) must be lower case too. Anything else is left as it is.
 */
export const LowerCaseUuid = () =>
  Transform(({ value }: { value: unknown }) =>
    Array.isArray(value) ? value.map(lower) : lower(value),
  );
