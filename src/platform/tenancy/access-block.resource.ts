import { BlockSectionName, type BlockSection } from '../../common/auth/block-section.js';
import { authorOf, type AuthorRef } from '../../common/http/author-stamps.js';
import type { AccessBlockRow, SocietyBlockRow } from './access-block.repository.js';
import type { People } from './society.resource.js';

/** A block as Super Admin sees it (PLT-42, PLT-44). */
export interface AccessBlockResource {
  id: string;
  section: 'owners' | 'staff' | 'students';
  societyId: string;
  institutionId: string | null;
  reason: string;
  blockedAt: string;
  blockedBy: AuthorRef;
}

/** A block of the caller's own Society as its Owner sees it (SOC-02). */
export interface SocietyBlockResource {
  id: string;
  section: 'owners' | 'staff' | 'students';
  institutionId: string | null;
  institutionName: string | null;
  reason: string;
  blockedAt: string;
}

/** Everyone a block names, for one lookup. */
export function peopleOfBlocks(rows: readonly AccessBlockRow[]): string[] {
  return [...new Set(rows.map((row) => row.created_by))];
}

export function blockResource(row: AccessBlockRow, people: People): AccessBlockResource {
  return {
    id: row.id,
    section: BlockSectionName[row.section as BlockSection],
    societyId: row.society_id,
    institutionId: row.institution_id,
    reason: row.reason,
    blockedAt: row.created_at.toISOString(),
    blockedBy: authorOf(row.created_by, people),
  };
}

export function societyBlockResource(row: SocietyBlockRow): SocietyBlockResource {
  return {
    id: row.id,
    section: BlockSectionName[row.section as BlockSection],
    institutionId: row.institution_id,
    institutionName: row.institution_name,
    reason: row.reason,
    blockedAt: row.created_at.toISOString(),
  };
}
