import type { FieldError } from '../http/field-error.type.js';
import { message } from '../i18n/messages.js';
import { RequestContext } from '../request-context/request-context.js';

/** One field error in the caller's language, for a rule only the service can check (API design 8). */
export function fieldError(field: string, code: string): FieldError {
  return { field, code, message: message(code, RequestContext.current()?.language) };
}
