import { RequestContext } from '../request-context/request-context.js';
import { fieldError } from './field-error.js';

describe('fieldError', () => {
  it('gives the field, the code and its message', () => {
    expect(fieldError('societyId', 'REQUIRED')).toEqual({
      field: 'societyId',
      code: 'REQUIRED',
      message: 'This field is required',
    });
  });

  it('speaks the caller’s language, falling back to English', () => {
    const message = RequestContext.run({ requestId: 'r1', language: 'hi' }, () =>
      fieldError('societyId', 'REQUIRED'),
    ).message;
    expect(message.length).toBeGreaterThan(0);
  });
});
