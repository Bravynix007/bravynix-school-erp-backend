import { sql, type RawBuilder } from 'kysely';
import { BlockSection } from '../../common/auth/block-section.js';

/**
 * SQL for "this row has an active block", used in the Super Admin's lists. They
 * read `access_blocks` under the Super Admin's row-level security policy, so
 * they are not for other callers, who see blocks through `app_active_blocks`.
 */
export function societyHasBlock(section: BlockSection): RawBuilder<boolean> {
  return sql<boolean>`exists (
    select 1 from access_blocks b
    where b.society_id = societies.id and b.section = ${section} and b.lifted_at is null
  )`;
}

export function institutionHasBlock(section: BlockSection): RawBuilder<boolean> {
  return sql<boolean>`exists (
    select 1 from access_blocks b
    where b.institution_id = institutions.id and b.section = ${section} and b.lifted_at is null
  )`;
}
