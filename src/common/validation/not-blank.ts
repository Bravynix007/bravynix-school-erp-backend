import { Matches } from 'class-validator';

/**
 * Text that is not only spaces: `"   "` is 400 `INVALID_FORMAT`. An empty string is left to `@MinLength(1)`, which
 * answers it `TOO_SHORT`. A required text field has both, because the database refuses a name that is only spaces,
 * which would otherwise surface as a server error.
 */
export const NotBlank = () => Matches(/\S|^$/);
