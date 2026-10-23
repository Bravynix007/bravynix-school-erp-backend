import { SetMetadata } from '@nestjs/common';

export const RAW_RESPONSE = 'http:raw-response';

/**
 * Skips the response envelope. Only for endpoints outside `/v1` whose
 * consumer is not an app client, such as load-balancer health checks.
 */
export const RawResponse = (): MethodDecorator & ClassDecorator => SetMetadata(RAW_RESPONSE, true);
