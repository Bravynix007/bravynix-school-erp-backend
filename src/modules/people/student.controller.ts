import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Principal } from '../../common/auth/access-token-verifier.js';
import { CurrentPrincipal } from '../../common/auth/current-principal.decorator.js';
import { Policy } from '../../common/auth/policy.decorator.js';
import { RoleCode } from '../../common/auth/roles.js';
import { ApiResult } from '../../common/http/api-result.js';
import { UuidParamPipe } from '../../common/http/uuid-param.pipe.js';
import { CreateStudentDto, ListStudentsQueryDto } from './student.dto.js';
import type { StudentResource, StudentSummary } from './student.resource.js';
import { StudentService } from './student.service.js';

const ADMINS = [RoleCode.SocietyOwner, RoleCode.InstitutionAdmin];

/** STU-01 to STU-03 (API design 9.6): the students of an Institution. */
@ApiTags('Students')
@Controller('students')
export class StudentController {
  constructor(private readonly students: StudentService) {}

  @Policy({
    roles: ADMINS,
    scope: 'institution',
    operationId: 'STU-01',
    rule: 'Lists the students whose Institution the caller reaches, a page at a time, with search by name, Admission ID or roll number and filters by year, class and section',
  })
  @Get()
  list(
    @CurrentPrincipal() principal: Principal,
    @Query() query: ListStudentsQueryDto,
  ): Promise<ApiResult<StudentSummary[]>> {
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
    roles: ADMINS,
    scope: 'institution',
    operationId: 'STU-03',
    rule: 'The profile of a student whose Institution the caller reaches, with the placement and the guardians',
  })
  @Get(':studentId')
  get(
    @CurrentPrincipal() principal: Principal,
    @Param('studentId', UuidParamPipe) studentId: string,
  ): Promise<StudentResource> {
    return this.students.get(principal, studentId);
  }
}
