import { body, problems } from '../../../test/support/dto-validation.js';
import { CreateSectionDto, UpdateSectionDto } from './section.dto.js';

const classId = '0192f3b0-0000-7000-8000-0000000000c1';
const predefinedSectionId = '0192f3b0-0000-7000-8000-0000000000d1';

describe('CreateSectionDto', () => {
  it('takes a class and a predefined section, with a name and a capacity or without', async () => {
    expect(await problems(body(CreateSectionDto, { classId, predefinedSectionId }))).toEqual([]);
    expect(
      await problems(
        body(CreateSectionDto, { classId, predefinedSectionId, displayName: 'Rose', capacity: 40 }),
      ),
    ).toEqual([]);
    expect(
      await problems(
        body(CreateSectionDto, { classId, predefinedSectionId, displayName: null, capacity: null }),
      ),
    ).toEqual([]);
  });

  it.each([
    [{ predefinedSectionId }, 'classId', 'INVALID_FORMAT'],
    [{ classId }, 'predefinedSectionId', 'INVALID_FORMAT'],
    [{ classId, predefinedSectionId, displayName: '' }, 'displayName', 'TOO_SHORT'],
    [{ classId, predefinedSectionId, displayName: 'x'.repeat(31) }, 'displayName', 'TOO_LONG'],
    [{ classId, predefinedSectionId, capacity: 0 }, 'capacity', 'OUT_OF_RANGE'],
    [{ classId, predefinedSectionId, capacity: 32_768 }, 'capacity', 'OUT_OF_RANGE'],
    [{ classId, predefinedSectionId, capacity: 40.5 }, 'capacity', 'INVALID_TYPE'],
    [{ classId, predefinedSectionId, capacity: '40' }, 'capacity', 'INVALID_TYPE'],
    [{ classId, predefinedSectionId, status: 0 }, 'status', 'FIELD_NOT_ALLOWED'],
  ])('refuses %j', async (value, field, code) => {
    expect(await problems(body(CreateSectionDto, value))).toContainEqual({ field, code });
  });
});

describe('UpdateSectionDto', () => {
  it('needs the version, and takes a name, a capacity (null clears it) or neither', async () => {
    expect(await problems(body(UpdateSectionDto, { version: 1 }))).toEqual([]);
    expect(
      await problems(body(UpdateSectionDto, { version: 2, displayName: 'Rose', capacity: null })),
    ).toEqual([]);
    expect(await problems(body(UpdateSectionDto, { capacity: 30 }))).toContainEqual({
      field: 'version',
      code: 'INVALID_TYPE',
    });
  });

  it.each([
    [{ version: 1, displayName: null }, 'displayName', 'INVALID_TYPE'],
    [{ version: 1, capacity: 0 }, 'capacity', 'OUT_OF_RANGE'],
    [{ version: 1, classId }, 'classId', 'FIELD_NOT_ALLOWED'],
    [{ version: 1, predefinedSectionId }, 'predefinedSectionId', 'FIELD_NOT_ALLOWED'],
  ])('refuses %j', async (value, field, code) => {
    expect(await problems(body(UpdateSectionDto, value))).toContainEqual({ field, code });
  });
});
