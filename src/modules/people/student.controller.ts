import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Principal } from '../../common/auth/access-token-verifier.js';
import { CurrentPrincipal } from '../../common/auth/current-principal.decorator.js';
import { Policy } from '../../common/auth/policy.decorator.js';
import { RoleCode } from '../../common/auth/roles.js';
import { ApiResult } from '../../common/http/api-result.js';
import { UuidParamPipe } from '../../common/http/uuid-param.pipe.js';
import {
  CreateStudentDto,
  DeactivateStudentDto,
  ListStudentsQueryDto,
  MoveStudentDto,
  UpdateStudentDto,
} from './student.dto.js';
import type {
  StudentClassroomResource,
  StudentResource,
  StudentSummary,
} from './student.resource.js';
import { StudentService } from './student.service.js';

const ADMINS = [RoleCode.SocietyOwner, RoleCode.InstitutionAdmin];
const READERS = [...ADMINS, RoleCode.TeacherStaff];

/** STU-01 to STU-05 and STU-08 (API design 9.6): the students of an Institution. */
@ApiTags('Students')
@Controller('students')
export class StudentController {
  constructor(private readonly students: StudentService) {}

  @Policy({
    roles: READERS,
    scope: 'institution',
    operationId: 'STU-01',
    rule: 'Lists the students whose Institution the caller reaches, a page at a time, with search by name, Admission ID or roll number and filters by year, class and section; a Teacher or Staff member gets the classroom view of the students in their own sections',
  })
  @Get()
  list(
    @CurrentPrincipal() principal: Principal,
    @Query() query: ListStudentsQueryDto,
  ): Promise<ApiResult<StudentSummary[] | StudentClassroomResource[]>> {
    return this.students.list(principal, query);
  }

  @Policy({
    roles: ADMINS,
    scope: 'institution',
    operationId: 'STU-02',
    rule: 'Adds a student at an Institution the caller reaches with class, section, roll number and one to five guardians; a guardian email links a parent login, and a full section is a warning',
  })
  @Post()
  create(
    @CurrentPrincipal() principal: Principal,
    @Body() body: CreateStudentDto,
  ): Promise<ApiResult<StudentResource>> {
    return this.students.create(principal, body);
  }

  @Policy({
    roles: READERS,
    scope: 'institution',
    operationId: 'STU-03',
    rule: 'The profile of a student whose Institution the caller reaches, with the placement and the guardians; a Teacher or Staff member gets the classroom view of a student in their own sections, else 403 NOT_ASSIGNED',
  })
  @Get(':studentId')
  get(
    @CurrentPrincipal() principal: Principal,
    @Param('studentId', UuidParamPipe) studentId: string,
  ): Promise<StudentResource | StudentClassroomResource> {
    return this.students.get(principal, studentId);
  }

  @Policy({
    roles: ADMINS,
    scope: 'institution',
    operationId: 'STU-04',
    rule: 'Edits an active student’s personal and contact fields by version; the class, section and guardians change on their own endpoints',
  })
  @Patch(':studentId')
  update(
    @CurrentPrincipal() principal: Principal,
    @Param('studentId', UuidParamPipe) studentId: string,
    @Body() body: UpdateStudentDto,
  ): Promise<StudentResource> {
    return this.students.update(principal, studentId, body);
  }

  @Policy({
    roles: ADMINS,
    scope: 'institution',
    operationId: 'STU-05',
    rule: 'Deactivates a student with a reason (left, mistake, other); the Admission ID and the roll number are free again and the guardians lose the child',
  })
  @Delete(':studentId')
  deactivate(
    @CurrentPrincipal() principal: Principal,
    @Param('studentId', UuidParamPipe) studentId: string,
    @Body() body: DeactivateStudentDto,
  ): Promise<{ id: string; status: 0 }> {
    return this.students.deactivate(principal, studentId, body);
  }

  @Policy({
    roles: ADMINS,
    scope: 'institution',
    operationId: 'STU-08',
    rule: 'Moves a student to another section of their class, or changes their roll number, from a date; the old placement ends the day before and a full section is a warning',
  })
  @Patch(':studentId/placement')
  move(
    @CurrentPrincipal() principal: Principal,
    @Param('studentId', UuidParamPipe) studentId: string,
    @Body() body: MoveStudentDto,
  ): Promise<ApiResult<StudentResource>> {
    return this.students.move(principal, studentId, body);
  }
}
