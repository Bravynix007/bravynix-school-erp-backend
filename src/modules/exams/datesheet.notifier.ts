import { Injectable } from '@nestjs/common';
import { Clock } from '../../common/time/clock.js';
import type { Tx } from '../../platform/database/index.js';
import { MAX_RECEIVERS, Notifications, type Receiver } from '../../platform/notifications/index.js';
import { SubjectDirectory } from '../academic-setup/index.js';
import type { ExamPaperRow } from './exam-paper.repository.js';
import { ExamPeople } from './exam-people.js';
import type { ExamRow } from './exam.repository.js';
import { paperNotice, publishedNotice, type PaperChange } from './datesheet.notice.js';

/**
 * Tells the people of a datesheet (PRD 7.11 step 2, Phase 6 decision 4): the guardians of the children now in a
 * paper's section and the staff named on it. The notice is a job saved in the caller's transaction, so it exists only
 * if the change does. An audience larger than one notice may name is sent as several.
 */
@Injectable()
export class DatesheetNotifier {
  constructor(
    private readonly notifications: Notifications,
    private readonly examPeople: ExamPeople,
    private readonly subjects: SubjectDirectory,
    private readonly clock: Clock,
  ) {}

  /** The datesheet's first publication: everyone on any of its papers. */
  async published(
    tx: Tx,
    exam: ExamRow,
    papers: readonly ExamPaperRow[],
    by: string,
  ): Promise<void> {
    const receivers = await this.receiversOf(tx, papers, []);
    for (const [index, part] of parts(receivers).entries()) {
      const notice = publishedNotice(exam, part);
      await this.notifications.notify(
        tx,
        index === 0 ? notice : { ...notice, sourceKey: `${notice.sourceKey}:${index.toString()}` },
        by,
      );
    }
  }

  /**
   * A paper of a published datesheet was added, changed or removed: the section's guardians and the staff on the paper,
   * with `staffBefore` (the teacher and invigilator it had), who are told too when the change takes them off it.
   */
  async changed(
    tx: Tx,
    exam: ExamRow,
    paper: ExamPaperRow,
    change: PaperChange,
    staffBefore: readonly (string | null)[],
    by: string,
  ): Promise<void> {
    const receivers = await this.receiversOf(tx, [paper], staffBefore);
    if (receivers.length === 0) return;
    const subjectName = (await this.subjects.names(tx, [paper.subject_id])).get(paper.subject_id);
    for (const [index, part] of parts(receivers).entries()) {
      const notice = paperNotice(exam, paper, subjectName ?? 'exam', change, part);
      await this.notifications.notify(
        tx,
        index === 0 ? notice : { ...notice, sourceKey: `${notice.sourceKey}:${index.toString()}` },
        by,
      );
    }
  }

  /** The guardians of each paper's section (with the child) and the staff of the papers, each person once. */
  private async receiversOf(
    tx: Tx,
    papers: readonly ExamPaperRow[],
    extraStaff: readonly (string | null)[],
  ): Promise<Receiver[]> {
    const today = this.clock.todayIst();
    const receivers = new Map<string, Receiver>();
    for (const sectionId of new Set(papers.map((paper) => paper.section_id))) {
      for (const guardian of await this.examPeople.guardianReceivers(tx, sectionId, today)) {
        receivers.set(`${guardian.userId}:${guardian.studentId}`, guardian);
      }
    }
    const staffIds = new Set(
      [
        ...papers.flatMap((paper) => [
          paper.subject_teacher_staff_member_id,
          paper.invigilator_staff_member_id,
        ]),
        ...extraStaff,
      ].filter((id): id is string => id !== null),
    );
    for (const userId of await this.examPeople.staffUserIds(tx, [...staffIds])) {
      receivers.set(`${userId}:`, { userId });
    }
    return [...receivers.values()];
  }
}

/** The audience in notices of the most receivers one notice may name. */
function parts(receivers: readonly Receiver[]): Receiver[][] {
  const out: Receiver[][] = [];
  for (let from = 0; from < receivers.length; from += MAX_RECEIVERS) {
    out.push(receivers.slice(from, from + MAX_RECEIVERS));
  }
  return out;
}
