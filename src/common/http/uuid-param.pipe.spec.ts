import { UuidParamPipe } from './uuid-param.pipe.js';

describe('UuidParamPipe', () => {
  const pipe = new UuidParamPipe();

  it('passes a UUID, in lower case', () => {
    expect(pipe.transform('0192F4C2-1A7B-7C00-8E1F-2B3C4D5E6F70')).toBe(
      '0192f4c2-1a7b-7c00-8e1f-2b3c4d5e6f70',
    );
  });

  it.each(['', 'abc', '123', '0192f4c2-1a7b-7c00-8e1f-2b3c4d5e6f7', "x' or 1=1"])(
    'answers 404 for %j, as for an unknown ID',
    (value) => {
      expect(() => pipe.transform(value)).toThrow(
        expect.objectContaining({ status: 404, code: 'NOT_FOUND' }),
      );
    },
  );
});
