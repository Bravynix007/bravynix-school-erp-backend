import { HttpStatus } from '@nestjs/common';
import { RoleCode } from '../../common/auth/roles.js';
import { AppException } from '../../common/http/app-exception.js';
import { ErrorCode, FieldErrorCode } from '../../common/http/error-codes.js';
import { daysBetween } from '../../common/time/calendar-days.js';
import { fieldError } from '../../common/validation/field-error.js';

/** Who an event is for (DDD 9.8). */
const Audience = { Everyone: 1, StudentsAndParents: 2, Staff: 3 } as const;
export const AUDIENCES = [1, 2, 3] as const;

/** Who may change an event (PRD 7.12): 1 the Society's, shown in every Institution; 2 one Institution's. */
export const EventScope = { Society: 1, Institution: 2 } as const;
export const EVENT_SCOPES = [1, 2] as const;

/** 1 Public holiday, 2 Vacation, 3 Event holiday, 4 Optional (DDD 9.8). */
export const HOLIDAY_TYPES = [1, 2, 3, 4] as const;

/**
 * The preset pictures the app ships for an event with no upload of its own; the app maps each code to its image.
 * A code outside this list is 400 `INVALID_CODE` (API design 10.26, 13.x code lists).
 */
export const PRESET_IMAGES = [
  'assembly',
  'celebration',
  'cultural',
  'exam',
  'festival',
  'holiday',
  'meeting',
  'science',
  'sports',
  'trip',
] as const;

/** The most classes a holiday can name: the predefined classes there are. */
export const MAX_HOLIDAY_CLASSES = 40;

/** The longest span of dates one list asks for (API design 13.2). */
const MAX_RANGE_DAYS = 366;

/** What an event holds that rules look at, as a request or a stored row has it. */
export interface EventFields {
  startDate: string;
  endDate: string;
  isHoliday: boolean;
  holidayType: number | null;
  holidayForStudents: boolean;
  holidayForStaff: boolean;
  holidayPredefinedClassIds: readonly string[];
}

/**
 * The rules that join several fields (API design 10.26), as 400 on the field that is wrong: the end is not before the
 * start; a holiday says its type and who it is for, and a plain event says neither; classes limit a holiday for
 * students only, and name each class once.
 */
export function checkEventFields(event: EventFields): void {
  const errors = [];
  if (event.endDate < event.startDate) {
    errors.push(fieldError('endDate', FieldErrorCode.OUT_OF_RANGE));
  }
  if (event.isHoliday) {
    if (event.holidayType === null) errors.push(fieldError('holidayType', FieldErrorCode.REQUIRED));
    if (!event.holidayForStudents && !event.holidayForStaff) {
      errors.push(fieldError('holidayForStudents', FieldErrorCode.REQUIRED));
    }
    if (event.holidayPredefinedClassIds.length > 0 && !event.holidayForStudents) {
      errors.push(fieldError('holidayPredefinedClassIds', FieldErrorCode.FIELD_NOT_ALLOWED));
    }
  } else {
    if (event.holidayType !== null) {
      errors.push(fieldError('holidayType', FieldErrorCode.FIELD_NOT_ALLOWED));
    }
    if (event.holidayForStudents) {
      errors.push(fieldError('holidayForStudents', FieldErrorCode.FIELD_NOT_ALLOWED));
    }
    if (event.holidayForStaff) {
      errors.push(fieldError('holidayForStaff', FieldErrorCode.FIELD_NOT_ALLOWED));
    }
    if (event.holidayPredefinedClassIds.length > 0) {
      errors.push(fieldError('holidayPredefinedClassIds', FieldErrorCode.FIELD_NOT_ALLOWED));
    }
  }
  if (new Set(event.holidayPredefinedClassIds).size !== event.holidayPredefinedClassIds.length) {
    errors.push(fieldError('holidayPredefinedClassIds', FieldErrorCode.INVALID_VALUE));
  }
  if (errors.length > 0) throw AppException.validation(errors);
}

/** The picture of an event: one the app ships, or one its organiser uploaded (a Ready file of purpose 10), never both. */
export interface EventPicture {
  presetImageCode: string | null;
  imageFileId: string | null;
}

/**
 * The picture an event ends with. A field left out stays; naming one kind of picture drops the other, so choosing an
 * upload over a preset (or back) is one change; naming both is 400 `FIELD_NOT_ALLOWED` on the preset.
 */
export function pictureAfter(
  current: EventPicture,
  asked: { presetImageCode?: string | null; imageFileId?: string | null },
): EventPicture {
  if (asked.presetImageCode != null && asked.imageFileId != null) {
    throw AppException.validation([
      fieldError('presetImageCode', FieldErrorCode.FIELD_NOT_ALLOWED),
    ]);
  }
  return {
    presetImageCode:
      asked.presetImageCode !== undefined
        ? asked.presetImageCode
        : asked.imageFileId != null
          ? null
          : current.presetImageCode,
    imageFileId:
      asked.imageFileId !== undefined
        ? asked.imageFileId
        : asked.presetImageCode != null
          ? null
          : current.imageFileId,
  };
}

/** A scope and its Institution go together: an Institution exactly when the scope is 2 (400 on `institutionId`). */
export function checkScope(scope: number, institutionId: string | null | undefined): void {
  if (scope === EventScope.Institution && !institutionId) {
    throw AppException.validation([fieldError('institutionId', FieldErrorCode.REQUIRED)]);
  }
  if (scope === EventScope.Society && institutionId) {
    throw AppException.validation([fieldError('institutionId', FieldErrorCode.FIELD_NOT_ALLOWED)]);
  }
}

/** The span a list asks for: ordered, and at most `MAX_RANGE_DAYS` (400 `RANGE_TOO_LARGE`). */
export function checkRange(from: string, to: string): void {
  if (to < from) throw AppException.validation([fieldError('to', FieldErrorCode.INVALID_VALUE)]);
  if (daysBetween(from, to) + 1 > MAX_RANGE_DAYS) {
    throw new AppException(HttpStatus.BAD_REQUEST, ErrorCode.RANGE_TOO_LARGE, {
      errors: [fieldError('to', FieldErrorCode.OUT_OF_RANGE)],
    });
  }
}

/** The audiences a role is told about: Owners and Admins see every event, staff the ones for everyone or staff. */
export function visibleAudiences(role: RoleCode | null): readonly number[] {
  switch (role) {
    case RoleCode.SocietyOwner:
    case RoleCode.InstitutionAdmin:
      return AUDIENCES;
    case RoleCode.TeacherStaff:
      return [Audience.Everyone, Audience.Staff];
    case RoleCode.StudentParent:
      return [Audience.Everyone, Audience.StudentsAndParents];
    default:
      return [];
  }
}

/** Whether the caller may change an event they can see: the Owner any, an Admin only an Institution's (PRD 7.12). */
export function mayEdit(role: RoleCode | null, scope: number): boolean {
  if (role === RoleCode.SocietyOwner) return true;
  return role === RoleCode.InstitutionAdmin && scope === EventScope.Institution;
}

/** Which people an audience is made of: the staff (Owners, Admins, Teachers and Staff), the parents, or both. */
export function audienceGroups(audience: number): { staff: boolean; parents: boolean } {
  switch (audience) {
    case Audience.StudentsAndParents:
      return { staff: false, parents: true };
    case Audience.Staff:
      return { staff: true, parents: false };
    default:
      return { staff: true, parents: true };
  }
}

/** Whether the parents are told: not of a holiday that is for staff alone. */
export function parentsAreTold(
  event: Pick<EventFields, 'isHoliday' | 'holidayForStudents'>,
): boolean {
  return !event.isHoliday || event.holidayForStudents;
}

/** The inbox tab a notice about the audience sits in: 2 All, 3 All teachers, 4 All students (API design 16.1). */
export function inboxTabOf(audience: number): 2 | 3 | 4 {
  switch (audience) {
    case Audience.StudentsAndParents:
      return 4;
    case Audience.Staff:
      return 3;
    default:
      return 2;
  }
}
