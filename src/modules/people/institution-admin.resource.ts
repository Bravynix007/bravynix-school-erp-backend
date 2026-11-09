/** One Institution Admin grant: the Institution, the staff record it is tied to and the person (INS-08, INS-09). */
export interface InstitutionAdminResource {
  institutionId: string;
  staffMemberId: string;
  person: { id: string; displayName: string };
  grantedAt: string;
}
