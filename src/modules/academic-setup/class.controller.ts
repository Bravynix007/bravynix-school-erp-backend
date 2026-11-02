import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Principal } from '../../common/auth/access-token-verifier.js';
import { CurrentPrincipal } from '../../common/auth/current-principal.decorator.js';
import { Policy } from '../../common/auth/policy.decorator.js';
import { RoleCode } from '../../common/auth/roles.js';
import { ApiResult } from '../../common/http/api-result.js';
import { UuidParamPipe } from '../../common/http/uuid-param.pipe.js';
import {
  CreateClassDto,
  CreateClassesDto,
  ListClassesQueryDto,
  UpdateClassDto,
} from './class.dto.js';
import type { ClassResource } from './class.resource.js';
import { ClassService } from './class.service.js';
import { CreateSectionDto, UpdateSectionDto } from './section.dto.js';
import type { SectionResource } from './section.resource.js';
import { SectionService } from './section.service.js';

const WRITERS = [RoleCode.SocietyOwner, RoleCode.InstitutionAdmin];
const READERS = [...WRITERS, RoleCode.TeacherStaff, RoleCode.StudentParent];

/** CLS-01 to CLS-05 and SEC-01 (API design 10.4j): the classes of an Institution and the sections of a class. */
@ApiTags('Classes')
@Controller('classes')
export class ClassController {
  constructor(
    private readonly classes: ClassService,
    private readonly sections: SectionService,
  ) {}

  @Policy({
    roles: READERS,
    scope: 'institution',
    operationId: 'CLS-01',
    rule: 'The active classes of an Institution in the caller’s scope, with section counts; staff and parents reach them when the People module lands',
  })
  @Get()
  list(
    @CurrentPrincipal() principal: Principal,
    @Query() query: ListClassesQueryDto,
  ): Promise<ApiResult<ClassResource[]>> {
    return this.classes.list(principal, query);
  }

  @Policy({
    roles: WRITERS,
    scope: 'institution',
    operationId: 'CLS-02',
    rule: 'Adds a class from a predefined class, in a category the Institution offers',
  })
  @Post()
  async create(
    @CurrentPrincipal() principal: Principal,
    @Body() body: CreateClassDto,
  ): Promise<ApiResult<ClassResource>> {
    return ApiResult.created(await this.classes.create(principal, body));
  }

  @Policy({
    roles: WRITERS,
    scope: 'institution',
    operationId: 'CLS-03',
    rule: 'Adds up to 50 classes at once, all or nothing',
  })
  @Post('bulk')
  async createMany(
    @CurrentPrincipal() principal: Principal,
    @Body() body: CreateClassesDto,
  ): Promise<ApiResult<ClassResource[]>> {
    return ApiResult.created(await this.classes.createMany(principal, body));
  }

  @Policy({
    roles: WRITERS,
    scope: 'institution',
    operationId: 'CLS-04',
    rule: 'Edits the name or code of an active class',
  })
  @Patch(':classId')
  update(
    @CurrentPrincipal() principal: Principal,
    @Param('classId', UuidParamPipe) classId: string,
    @Body() body: UpdateClassDto,
  ): Promise<ClassResource> {
    return this.classes.update(principal, classId, body);
  }

  @Policy({
    roles: WRITERS,
    scope: 'institution',
    operationId: 'CLS-05',
    rule: 'Deactivates a class and its sections; nothing is deleted',
  })
  @Delete(':classId')
  deactivate(
    @CurrentPrincipal() principal: Principal,
    @Param('classId', UuidParamPipe) classId: string,
  ): Promise<{ id: string; status: 0 }> {
    return this.classes.deactivate(principal, classId);
  }

  @Policy({
    roles: READERS,
    scope: 'institution',
    operationId: 'SEC-01',
    rule: 'The active sections of a class in the caller’s scope',
  })
  @Get(':classId/sections')
  sectionsOf(
    @CurrentPrincipal() principal: Principal,
    @Param('classId', UuidParamPipe) classId: string,
  ): Promise<ApiResult<SectionResource[]>> {
    return this.sections.list(principal, classId);
  }
}

/** SEC-02 to SEC-04 (API design 10.4j). */
@ApiTags('Classes')
@Controller('sections')
export class SectionController {
  constructor(private readonly sections: SectionService) {}

  @Policy({
    roles: WRITERS,
    scope: 'institution',
    operationId: 'SEC-02',
    rule: 'Adds a section to an active class, from a predefined section',
  })
  @Post()
  async create(
    @CurrentPrincipal() principal: Principal,
    @Body() body: CreateSectionDto,
  ): Promise<ApiResult<SectionResource>> {
    return ApiResult.created(await this.sections.create(principal, body));
  }

  @Policy({
    roles: WRITERS,
    scope: 'institution',
    operationId: 'SEC-03',
    rule: 'Edits the name or capacity of an active section',
  })
  @Patch(':sectionId')
  update(
    @CurrentPrincipal() principal: Principal,
    @Param('sectionId', UuidParamPipe) sectionId: string,
    @Body() body: UpdateSectionDto,
  ): Promise<SectionResource> {
    return this.sections.update(principal, sectionId, body);
  }

  @Policy({
    roles: WRITERS,
    scope: 'institution',
    operationId: 'SEC-04',
    rule: 'Deactivates a section; nothing is deleted',
  })
  @Delete(':sectionId')
  deactivate(
    @CurrentPrincipal() principal: Principal,
    @Param('sectionId', UuidParamPipe) sectionId: string,
  ): Promise<{ id: string; status: 0 }> {
    return this.sections.deactivate(principal, sectionId);
  }
}
