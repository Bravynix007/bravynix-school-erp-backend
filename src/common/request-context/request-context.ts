import { AsyncLocalStorage } from 'node:async_hooks';
import type { Language } from '../i18n/messages.js';

export interface RequestContextData {
  requestId: string;
  language: Language;
  /** Set by the auth guard once identity exists (phase 1). */
  personId?: string;
  societyId?: string;
  roleCode?: number;
  /** The caller's name as it should read in the audit log (frozen at the time). */
  displayName?: string;
  /** The caller's address, as Express resolves it behind the trusted proxies. */
  ipAddress?: string;
  userAgent?: string;
}

const storage = new AsyncLocalStorage<RequestContextData>();

/**
 * Per-request values available anywhere in the call chain without passing
 * them through every function: logging, audit stamps, translated messages.
 */
export const RequestContext = {
  run<T>(data: RequestContextData, fn: () => T): T {
    return storage.run(data, fn);
  },
  current(): RequestContextData | undefined {
    return storage.getStore();
  },
  requestId(): string | undefined {
    return storage.getStore()?.requestId;
  },
};
