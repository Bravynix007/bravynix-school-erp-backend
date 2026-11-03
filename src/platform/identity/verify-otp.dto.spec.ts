import { body, problems } from '../../../test/support/dto-validation.js';
import { VerifyOtpDto } from './verify-otp.dto.js';

const mobile = { email: 'asha.rao@example.com', code: '482913', clientType: 1 };

describe('VerifyOtpDto', () => {
  it('takes a device object for the mobile app', async () => {
    expect(
      await problems(
        body(VerifyOtpDto, { ...mobile, device: { platform: 1, appVersion: '1.4.0' } }),
      ),
    ).toEqual([]);
  });

  it.each([[[]], [[{ platform: 1, appVersion: '1.4.0' }]], ['phone']])(
    'refuses the device %j as INVALID_TYPE',
    async (device) => {
      expect(await problems(body(VerifyOtpDto, { ...mobile, device }))).toContainEqual({
        field: 'device',
        code: 'INVALID_TYPE',
      });
    },
  );
});
