import { body, problems } from '../../../test/support/dto-validation.js';
import { createValidationPipe } from '../../common/validation/validation.js';
import { GrantAdminDto, ListAdminsQueryDto } from './institution-admin.dto.js';

const id = '0192f3b0-0000-7000-8000-000000000001';

describe('GrantAdminDto', () => {
  it('takes a staff member ID, in either case', async () => {
    expect(await problems(body(GrantAdminDto, { staffMemberId: id }))).toEqual([]);
    const upper = await body(GrantAdminDto, { staffMemberId: id.toUpperCase() });
    expect(upper.staffMemberId).toBe(id);
  });

  it.each([
    ['nothing', {}, [{ field: 'staffMemberId', code: 'INVALID_FORMAT' }]],
    ['a word', { staffMemberId: 'nope' }, [{ field: 'staffMemberId', code: 'INVALID_FORMAT' }]],
    ['a number', { staffMemberId: 5 }, [{ field: 'staffMemberId', code: 'INVALID_FORMAT' }]],
    [
      'a field that is not allowed',
      { staffMemberId: id, roleCode: 2 },
      [{ field: 'roleCode', code: 'FIELD_NOT_ALLOWED' }],
    ],
  ])('refuses %s', async (_name, value, expected) => {
    expect(await problems(body(GrantAdminDto, value))).toEqual(expected);
  });
});

describe('ListAdminsQueryDto', () => {
  const pipe = createValidationPipe();
  const query = (value: unknown) =>
    pipe.transform(value, {
      type: 'query',
      metatype: ListAdminsQueryDto,
    }) as Promise<ListAdminsQueryDto>;

  it('takes a page and a limit, with the defaults of a page', async () => {
    expect(await query({})).toMatchObject({ page: 1, limit: 20 });
    expect(await query({ page: '2', limit: '5' })).toMatchObject({ page: 2, limit: 5 });
  });

  it('has no search and no sort', async () => {
    await expect(query({ q: 'asha' })).rejects.toMatchObject({ status: 400 });
    await expect(query({ sort: 'name' })).rejects.toMatchObject({ status: 400 });
  });
});
