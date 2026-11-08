import Busboy from 'busboy';
import type { NextFunction, Request, Response } from 'express';
import {
  LOCAL_STORAGE_PATH,
  type LocalGrant,
  type LocalObjectStorage,
} from './local-object-storage.js';

const ADDRESS = new RegExp(`^/v1${LOCAL_STORAGE_PATH}/([^/?#]+)$`);

/** An `Content-Disposition` filename that cannot break out of its quotes. */
function attachment(name: string | null): string {
  const safe = (name ?? 'file').replace(/[^\w.\- ]/g, '_');
  return `attachment; filename="${safe}"`;
}

function refuse(response: Response, status: number, code: string): void {
  response.status(status).json({ code });
}

/** Runs an async answer; if it throws, the caller gets a plain 500 instead of a hung request. */
function sendOrFail(response: Response, work: () => Promise<void>): void {
  work().catch(() => refuse(response, 500, 'INTERNAL_ERROR'));
}

function receive(
  storage: LocalObjectStorage,
  grant: LocalGrant,
  request: Request,
  response: Response,
): void {
  let busboy: Busboy.Busboy;
  try {
    busboy = Busboy({
      headers: request.headers,
      limits: { files: 1, fileSize: grant.maxBytes + 1, fields: 20 },
    });
  } catch {
    // Not a multipart form: JSON, or no body at all.
    return refuse(response, 400, 'BAD_UPLOAD');
  }
  const chunks: Buffer[] = [];
  let stored = false;
  let tooLarge = false;
  let wrongType = false;
  busboy.on('file', (_name, file, info) => {
    stored = true;
    wrongType = info.mimeType !== grant.contentType;
    file.on('data', (chunk: Buffer) => chunks.push(chunk));
    file.on('limit', () => {
      tooLarge = true;
    });
  });
  busboy.on('close', () => {
    if (!stored || wrongType) return refuse(response, 400, 'BAD_UPLOAD');
    if (tooLarge) return refuse(response, 413, 'PAYLOAD_TOO_LARGE');
    sendOrFail(response, async () => {
      if (!(await storage.write(grant.key, Buffer.concat(chunks)))) {
        return refuse(response, 409, 'ALREADY_UPLOADED');
      }
      response.status(204).end();
    });
  });
  busboy.on('error', () => refuse(response, 400, 'BAD_UPLOAD'));
  request.pipe(busboy);
}

/**
 * The address the local driver hands out, standing in for S3 (API design 15.1): `POST` takes one multipart
 * file the way a presigned POST does, `GET` serves one object as an attachment. It runs as plain middleware,
 * outside the API's guards and envelope, because the real store has none of them either: the signed address
 * is the only permission.
 */
export function localStorageMiddleware(storage: LocalObjectStorage) {
  return (request: Request, response: Response, next: NextFunction): void => {
    const token = ADDRESS.exec(request.path)?.[1];
    if (!token) return next();
    const grant = storage.verify(token);
    if (!grant) return refuse(response, 403, 'LINK_EXPIRED');
    if (request.method === 'POST' && grant.op === 'put')
      return receive(storage, grant, request, response);
    if (request.method === 'GET' && grant.op === 'get') {
      sendOrFail(response, async () => {
        const bytes = await storage.read(grant.key);
        if (!bytes) return refuse(response, 404, 'NOT_FOUND');
        response
          .status(200)
          .set({
            'Content-Type': grant.contentType,
            'Content-Disposition': attachment(grant.fileName),
            'Cache-Control': 'private, no-store',
          })
          .end(bytes);
      });
      return;
    }
    refuse(response, 405, 'METHOD_NOT_ALLOWED');
  };
}
