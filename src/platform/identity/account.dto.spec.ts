import { body, problems } from '../../../test/support/dto-validation.js';
import { ChangeEmailDto, NewPersonDto } from './account.dto.js';

describe('NewPersonDto', () => {
  it('takes an email alone, or with names', async () => {
    expect(await problems(body(NewPersonDto, { email: 'asha@example.com' }))).toEqual([]);
    expect(
      await problems(
        body(NewPersonDto, { email: 'asha@example.com', firstName: 'Asha', lastName: 'Rao' }),
      ),
    ).toEqual([]);
  });

  it.each([
    [{}, 'email'],
    [{ email: 'not-an-email' }, 'email'],
    [{ email: 'a@example.com', firstName: '' }, 'firstName'],
    [{ email: 'a@example.com', lastName: 'x'.repeat(101) }, 'lastName'],
    [{ email: 'a@example.com', role: 1 }, 'role'],
  ])('refuses %j', async (value, field) => {
    expect((await problems(body(NewPersonDto, value))).map((problem) => problem.field)).toContain(
      field,
    );
  });
});

describe('ChangeEmailDto', () => {
  it('needs the new email and the version', async () => {
    expect(await problems(body(ChangeEmailDto, { email: 'new@example.com', version: 2 }))).toEqual(
      [],
    );
    expect(await problems(body(ChangeEmailDto, { email: 'new@example.com' }))).not.toEqual([]);
    expect(await problems(body(ChangeEmailDto, { email: 'nope', version: 2 }))).not.toEqual([]);
  });
});
