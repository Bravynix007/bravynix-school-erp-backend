/**
 * PLT-01: the platform's business numbers (PRD 9.6). Money is a two-decimal
 * string. `activeStudents` and `openAiReports` are `null` until the modules that
 * hold them exist (People in Phase 4, AI reports in Phase 9), so a screen says
 * "not available yet" and never shows a made-up zero.
 */
export interface PlatformDashboard {
  societies: number;
  institutions: number;
  activeStudents: number | null;
  duesOutstandingAmount: string;
  duesCollectedThisMonthAmount: string;
  duesCollectedLastMonthAmount: string;
  openAiReports: number | null;
}
