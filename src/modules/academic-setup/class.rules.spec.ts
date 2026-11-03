import { AppException } from '../../common/http/app-exception.js';
import {
  defaultClassName,
  requireClassAllowed,
  requireNameFits,
  translateClassError,
  translateSectionError,
} from './class.rules.js';

function refusal(work: () => void): AppException {
  try {
    work();
  } catch (error) {
    if (error instanceof AppException) return error;
    throw error;
  }
  throw new Error('expected a refusal');
}

const unique = (constraint: string) =>
  Object.assign(new Error('unique'), { code: '23505', constraint });

describe('defaultClassName', () => {
  it('is the predefined name, with the stream after it when there is one', () => {
    expect(defaultClassName('7th', null)).toBe('7th');
    expect(defaultClassName('PUC 1st Year', 'PCMC')).toBe('PUC 1st Year PCMC');
  });
});

describe('requireClassAllowed', () => {
  it('lets an offered category through, with a stream only in Pre-University', () => {
    expect(() => requireClassAllowed({ code: 'HIGH_SCHOOL', offered: true }, null)).not.toThrow();
    expect(() =>
      requireClassAllowed({ code: 'PRE_UNIVERSITY', offered: true }, 'PCMC'),
    ).not.toThrow();
    expect(() =>
      requireClassAllowed({ code: 'PRE_UNIVERSITY', offered: true }, null),
    ).not.toThrow();
  });

  it('is 422 CLASS_NOT_OFFERED for a category the Institution does not offer, naming the field', () => {
    const error = refusal(() => requireClassAllowed({ code: 'HIGH_SCHOOL', offered: false }, null));
    expect(error).toMatchObject({ status: 422, code: 'CLASS_NOT_OFFERED' });
    expect(error.options.errors).toEqual([expect.objectContaining({ field: 'predefinedClassId' })]);
  });

  it('is 422 STREAM_NOT_ALLOWED for a stream outside Pre-University, with the place in a bulk request', () => {
    const error = refusal(() =>
      requireClassAllowed({ code: 'SENIOR_SECONDARY', offered: true }, 'Science', 'classes[2].'),
    );
    expect(error).toMatchObject({ status: 422, code: 'STREAM_NOT_ALLOWED' });
    expect(error.options.errors).toEqual([
      expect.objectContaining({ field: 'classes[2].streamName' }),
    ]);
  });

  it('checks the offer before the stream', () => {
    expect(
      refusal(() => requireClassAllowed({ code: 'HIGH_SCHOOL', offered: false }, 'x')).code,
    ).toBe('CLASS_NOT_OFFERED');
  });
});

describe('requireNameFits', () => {
  it('accepts sixty characters and refuses more with 400 TOO_LONG', () => {
    expect(() => requireNameFits('x'.repeat(60))).not.toThrow();
    const error = refusal(() => requireNameFits('x'.repeat(61), 'classes[0].'));
    expect(error.status).toBe(400);
    expect(error.options.errors).toEqual([
      expect.objectContaining({
        field: 'classes[0].displayName',
        code: 'TOO_LONG',
        params: { max: 60 },
      }),
    ]);
  });
});

describe('translateClassError', () => {
  it('turns the class index into DUPLICATE on the stream or the predefined class', () => {
    const index = unique('uq_classes_institution_class_stream');
    expect((translateClassError(index, true) as AppException).options.errors).toEqual([
      expect.objectContaining({ field: 'streamName', code: 'DUPLICATE' }),
    ]);
    expect(
      (translateClassError(index, false, 'classes[1].') as AppException).options.errors,
    ).toEqual([expect.objectContaining({ field: 'classes[1].predefinedClassId' })]);
  });

  it('turns the name index into DUPLICATE on displayName', () => {
    const error = translateClassError(unique('uq_classes_institution_name'), false) as AppException;
    expect(error).toMatchObject({ status: 409, code: 'DUPLICATE' });
    expect(error.options.errors).toEqual([expect.objectContaining({ field: 'displayName' })]);
  });

  it('turns a category unticked meanwhile into CLASS_NOT_OFFERED, and leaves other errors alone', () => {
    const fk = Object.assign(new Error('fk'), {
      code: '23503',
      constraint: 'fk_classes_offered_category',
    });
    expect(translateClassError(fk, false)).toMatchObject({
      status: 422,
      code: 'CLASS_NOT_OFFERED',
    });
    const other = new Error('boom');
    expect(translateClassError(other, false)).toBe(other);
  });
});

describe('translateSectionError', () => {
  it('turns the two indexes into DUPLICATE on the field, and leaves other errors alone', () => {
    expect(
      (translateSectionError(unique('uq_sections_class_predefined')) as AppException).options
        .errors,
    ).toEqual([expect.objectContaining({ field: 'predefinedSectionId', code: 'DUPLICATE' })]);
    expect(
      (translateSectionError(unique('uq_sections_class_name')) as AppException).options.errors,
    ).toEqual([expect.objectContaining({ field: 'displayName', code: 'DUPLICATE' })]);
    const other = new Error('boom');
    expect(translateSectionError(other)).toBe(other);
  });
});
