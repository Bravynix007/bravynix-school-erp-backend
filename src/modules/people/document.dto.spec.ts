import { body, problems } from '../../../test/support/dto-validation.js';
import { CreateStaffDocumentDto } from './document.dto.js';

const id = '0192f3b0-0000-7000-8000-000000000001';

describe('CreateStaffDocumentDto', () => {
  it('takes a title and a file, in either case', async () => {
    expect(await problems(body(CreateStaffDocumentDto, { title: 'Letter', fileId: id }))).toEqual(
      [],
    );
    const upper = await body(CreateStaffDocumentDto, { title: 'Letter', fileId: id.toUpperCase() });
    expect(upper.fileId).toBe(id);
  });

  it.each([
    ['no title', { fileId: id }, [{ field: 'title', code: 'INVALID_TYPE' }]],
    ['an empty title', { title: '', fileId: id }, [{ field: 'title', code: 'TOO_SHORT' }]],
    [
      'a title over 150',
      { title: 'x'.repeat(151), fileId: id },
      [{ field: 'title', code: 'TOO_LONG' }],
    ],
    ['no file', { title: 'Letter' }, [{ field: 'fileId', code: 'INVALID_FORMAT' }]],
    [
      'a word for the file',
      { title: 'Letter', fileId: 'x' },
      [{ field: 'fileId', code: 'INVALID_FORMAT' }],
    ],
    [
      'a field that is not allowed',
      { title: 'Letter', fileId: id, ownerType: 1 },
      [{ field: 'ownerType', code: 'FIELD_NOT_ALLOWED' }],
    ],
  ])('refuses %s', async (_name, value, expected) => {
    expect(await problems(body(CreateStaffDocumentDto, value))).toEqual(expected);
  });
});
