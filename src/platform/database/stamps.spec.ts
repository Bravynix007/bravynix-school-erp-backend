import { RequestContext } from '../../common/request-context/request-context.js';
import { insertStamp, updateStamp } from './stamps.js';

const PERSON = '0192f3a1-0b2c-7d3e-8f40-1a2b3c4d5e6f';

describe('author stamps', () => {
  it('use the caller of the request', () => {
    RequestContext.run({ requestId: 'r', language: 'en', personId: PERSON }, () => {
      expect(insertStamp()).toEqual({ created_by: PERSON, updated_by: PERSON });
      expect(updateStamp()).toEqual({ updated_by: PERSON });
    });
  });

  it('stay empty for a background job, which the app shows as "System"', () => {
    expect(insertStamp()).toEqual({ created_by: null, updated_by: null });
    expect(updateStamp()).toEqual({ updated_by: null });
  });

  it('take an explicit author, or null to force "System", over the request', () => {
    RequestContext.run({ requestId: 'r', language: 'en', personId: PERSON }, () => {
      expect(insertStamp('other')).toEqual({ created_by: 'other', updated_by: 'other' });
      expect(updateStamp(null)).toEqual({ updated_by: null });
    });
  });
});
