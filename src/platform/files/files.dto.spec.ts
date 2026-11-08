import { body, problems } from '../../../test/support/dto-validation.js';
import { RequestUploadDto } from './files.dto.js';

const valid = {
  purpose: 5,
  institutionId: '0192f3b7-4e5f-7061-9c72-4d5e6f708192',
  contentType: 'application/pdf',
  sizeBytes: 1024,
  fileName: 'admission-form.pdf',
};

describe('RequestUploadDto', () => {
  it('takes a purpose, an Institution, a type, a size and a name', async () => {
    expect(await problems(body(RequestUploadDto, valid))).toEqual([]);
  });

  it.each([
    [{ purpose: 99 }, 'purpose', 'INVALID_CODE'],
    [{ purpose: 14 }, 'purpose', 'INVALID_CODE'],
    [{ purpose: '5' }, 'purpose', 'INVALID_TYPE'],
    [{ institutionId: 'x' }, 'institutionId', 'INVALID_FORMAT'],
    [{ contentType: '' }, 'contentType', 'TOO_SHORT'],
    [{ sizeBytes: 0 }, 'sizeBytes', 'OUT_OF_RANGE'],
    [{ sizeBytes: '5' }, 'sizeBytes', 'INVALID_TYPE'],
    [{ sizeBytes: 1.5 }, 'sizeBytes', 'INVALID_TYPE'],
    [{ fileName: '' }, 'fileName', 'TOO_SHORT'],
    [{ fileName: 'x'.repeat(256) }, 'fileName', 'TOO_LONG'],
    [{ owner: { type: 'student', id: 'x' } }, 'owner', 'FIELD_NOT_ALLOWED'],
  ])('refuses %j', async (change, field, code) => {
    expect(await problems(body(RequestUploadDto, { ...valid, ...change }))).toContainEqual({
      field,
      code,
    });
  });
});
