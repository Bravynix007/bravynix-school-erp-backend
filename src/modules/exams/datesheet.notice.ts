import { formatDay } from '../../common/time/format-day.js';
import type { Notice, Receiver } from '../../platform/notifications/index.js';
import type { ExamPaperRow } from './exam-paper.repository.js';
import type { ExamRow } from './exam.repository.js';

/** The screen a notice about an exam opens (DDD 9.8). */
const EXAM_TARGET = 4;
/** The category of the notices about datesheets and results (DDD 9.8). */
const EXAM_CATEGORY = 4;
/** The inbox tab of a notice for one person: "Only for you". */
const ONLY_FOR_YOU = 1;

/** What happened to a paper of a published datesheet. */
export type PaperChange = 'added' | 'changed' | 'removed';

/**
 * The notice that a datesheet is out (PRD 7.11, API design 10.7): the exam and the days it runs, which are what the
 * datesheet screen shows and never more (SDD 18). Its key is the exam, so the job that writes it can run twice
 * without telling anyone twice.
 */
export function publishedNotice(exam: ExamRow, receivers: readonly Receiver[]): Notice {
  const days =
    exam.start_date === exam.end_date
      ? formatDay(exam.start_date)
      : `${formatDay(exam.start_date)} to ${formatDay(exam.end_date)}`;
  return {
    societyId: exam.society_id,
    institutionId: exam.institution_id,
    sourceKey: `datesheet:${exam.id}`,
    occurredAt: exam.updated_at,
    category: EXAM_CATEGORY,
    tab: ONLY_FOR_YOU,
    title: 'Exam datesheet published',
    body: `${exam.name}: ${days}.`,
    target: { type: EXAM_TARGET, id: exam.id },
    receivers: [...receivers],
  };
}

/**
 * The notice that a paper of a published datesheet was added, changed or removed. Its key is the paper and its
 * version, so each change is a new notice and a job that runs twice tells no one twice.
 */
export function paperNotice(
  exam: ExamRow,
  paper: ExamPaperRow,
  subjectName: string,
  change: PaperChange,
  receivers: readonly Receiver[],
): Notice {
  return {
    societyId: exam.society_id,
    institutionId: exam.institution_id,
    sourceKey: `datesheet-paper:${paper.id}:v${paper.version.toString()}`,
    occurredAt: change === 'added' ? paper.created_at : paper.updated_at,
    category: EXAM_CATEGORY,
    tab: ONLY_FOR_YOU,
    title: 'Exam datesheet updated',
    body: `${exam.name}: the ${subjectName} paper was ${change}.`,
    target: { type: EXAM_TARGET, id: exam.id },
    receivers: [...receivers],
  };
}
