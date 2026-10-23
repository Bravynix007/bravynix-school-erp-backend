/** Every business route lives under `/v1` (API design 5.2). */
export const API_PREFIX = 'v1';

/** Routes outside `/v1`: load-balancer health checks only (API design 5.1). */
export const UNPREFIXED_PATHS = ['/health/live', '/health/ready'] as const;

export function isUnprefixedPath(path: string): boolean {
  return (UNPREFIXED_PATHS as readonly string[]).includes(path);
}
