import { isIP } from 'node:net';
import { RequestContext } from '../../common/request-context/request-context.js';

/** The caller's address as Express resolved it; an IPv6 zone is dropped (`inet` refuses it) and an IPv4-mapped address is read as IPv4. */
export function requestIp(): string | null {
  const raw = RequestContext.current()?.ipAddress?.split('%')[0];
  const ip = raw?.replace(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i, '$1');
  return ip && isIP(ip) ? ip : null;
}
