import { body, problems } from '../../../test/support/dto-validation.js';
import {
  CreateClassDto,
  CreateClassesDto,
  ListClassesQueryDto,
  UpdateClassDto,
} from './class.dto.js';

const institutionId = '0192f3b0-0000-7000-8000-0000000000a1';
const predefinedClassId = '0192f3b0-0000-7000-8000-0000000000c1';

describe('ListClassesQueryDto', () => {
  it('needs an Institution ID', async () => {
    expect(await problems(body(ListClassesQueryDto, { institutionId }))).toEqual([]);
    expect(await problems(body(ListClassesQueryDto, {}))).toContainEqual({
      field: 'institutionId',
      code: 'INVALID_FORMAT',
    });
  });
});

describe('CreateClassDto', () => {
  it('takes a predefined class alone, or with a stream, a name and a code (any of them null)', async () => {
    expect(await problems(body(CreateClassDto, { institutionId, predefinedClassId }))).toEqual([]);
    expect(
      await problems(
        body(CreateClassDto, {
          institutionId,
          predefinedClassId,
          streamName: 'PCMC',
          displayName: 'PUC-I PCMC',
          code: 'P1',
        }),
      ),
    ).toEqual([]);
    expect(
      await problems(
        body(CreateClassDto, {
          institutionId,
          predefinedClassId,
          streamName: null,
          displayName: null,
          code: null,
        }),
      ),
    ).toEqual([]);
  });

  it.each([
    [{ institutionId }, 'predefinedClassId', 'INVALID_FORMAT'],
    [{ predefinedClassId }, 'institutionId', 'INVALID_FORMAT'],
    [{ institutionId, predefinedClassId: 'x' }, 'predefinedClassId', 'INVALID_FORMAT'],
    [{ institutionId, predefinedClassId, streamName: '' }, 'streamName', 'TOO_SHORT'],
    [{ institutionId, predefinedClassId, streamName: 'x'.repeat(31) }, 'streamName', 'TOO_LONG'],
    [{ institutionId, predefinedClassId, displayName: 'x'.repeat(61) }, 'displayName', 'TOO_LONG'],
    [{ institutionId, predefinedClassId, code: 'x'.repeat(51) }, 'code', 'TOO_LONG'],
    [{ institutionId, predefinedClassId, code: 5 }, 'code', 'INVALID_TYPE'],
    [{ institutionId, predefinedClassId, status: 0 }, 'status', 'FIELD_NOT_ALLOWED'],
    [{ institutionId, predefinedClassId, societyId: 'x' }, 'societyId', 'FIELD_NOT_ALLOWED'],
  ])('refuses %j', async (value, field, code) => {
    expect(await problems(body(CreateClassDto, value))).toContainEqual({ field, code });
  });
});

describe('CreateClassesDto', () => {
  const one = { predefinedClassId };

  it('takes one to fifty classes', async () => {
    expect(await problems(body(CreateClassesDto, { institutionId, classes: [one] }))).toEqual([]);
    expect(
      await problems(
        body(CreateClassesDto, { institutionId, classes: Array.from({ length: 50 }, () => one) }),
      ),
    ).toEqual([]);
  });

  it('refuses none, fifty-one, a non-list, and names the item that is wrong', async () => {
    expect(await problems(body(CreateClassesDto, { institutionId, classes: [] }))).toContainEqual({
      field: 'classes',
      code: 'TOO_FEW',
    });
    expect(
      await problems(
        body(CreateClassesDto, { institutionId, classes: Array.from({ length: 51 }, () => one) }),
      ),
    ).toContainEqual({ field: 'classes', code: 'TOO_MANY' });
    expect(await problems(body(CreateClassesDto, { institutionId, classes: 'x' }))).toContainEqual({
      field: 'classes',
      code: 'INVALID_TYPE',
    });
    expect(
      await problems(
        body(CreateClassesDto, { institutionId, classes: [one, { streamName: 'x'.repeat(31) }] }),
      ),
    ).toEqual(
      expect.arrayContaining([
        { field: 'classes[1].predefinedClassId', code: 'INVALID_FORMAT' },
        { field: 'classes[1].streamName', code: 'TOO_LONG' },
      ]),
    );
  });
});

describe('UpdateClassDto', () => {
  it('needs the version, and takes a name, a code (null clears it) or neither', async () => {
    expect(await problems(body(UpdateClassDto, { version: 1 }))).toEqual([]);
    expect(
      await problems(body(UpdateClassDto, { version: 2, displayName: 'Seventh', code: null })),
    ).toEqual([]);
    expect(await problems(body(UpdateClassDto, { displayName: 'x' }))).toContainEqual({
      field: 'version',
      code: 'INVALID_TYPE',
    });
  });

  it.each([
    [{ version: 1, displayName: null }, 'displayName', 'INVALID_TYPE'],
    [{ version: 1, displayName: '' }, 'displayName', 'TOO_SHORT'],
    [{ version: 1, code: '' }, 'code', 'TOO_SHORT'],
    [{ version: 1, streamName: 'PCMC' }, 'streamName', 'FIELD_NOT_ALLOWED'],
    [{ version: 1, predefinedClassId }, 'predefinedClassId', 'FIELD_NOT_ALLOWED'],
    [{ version: 1, institutionId }, 'institutionId', 'FIELD_NOT_ALLOWED'],
    [{ version: 1, status: 0 }, 'status', 'FIELD_NOT_ALLOWED'],
  ])('refuses %j', async (value, field, code) => {
    expect(await problems(body(UpdateClassDto, value))).toContainEqual({ field, code });
  });
});

describe('CreateClassesDto items', () => {
  it.each([[[]], [[{ predefinedClassId }]], ['C09'], [null]])(
    'refuses the item %j as INVALID_TYPE, so it never reaches the service',
    async (item) => {
      expect(
        await problems(body(CreateClassesDto, { institutionId, classes: [item] })),
      ).toContainEqual({ field: 'classes', code: 'INVALID_TYPE' });
    },
  );
});
