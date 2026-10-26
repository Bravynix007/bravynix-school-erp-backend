import request from 'supertest';
import type { TestApp } from './test-app.js';

/** The envelope every answer has (API design 7.1). */
export interface Body {
  success: boolean;
  code: string;
  data: Record<string, unknown> & { id: string; version: number };
  meta: Record<string, unknown> | null;
  errors?: { field: string; code: string }[];
}

type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';

/** Calls the API as the person holding `token`; the answer is status, envelope and headers. */
export function apiCaller(t: TestApp) {
  return async (method: Method, path: string, token: string, body?: object) => {
    const http = request(t.app.getHttpServer());
    const res = await http[method](path)
      .set('Authorization', `Bearer ${token}`)
      .send(method === 'get' || method === 'delete' ? undefined : (body ?? {}));
    return { status: res.status, body: res.body as Body, headers: res.headers };
  };
}
