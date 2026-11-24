import {
  DeleteObjectCommand,
  GetObjectCommand,
  NoSuchKey,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Clock } from '../../common/time/clock.js';
import { MAX_FILE_BYTES } from './file-purposes.js';
import {
  attachmentDisposition,
  isPublicKey,
  ObjectStorage,
  type DownloadTicket,
  type UploadTicket,
} from './object-storage.js';

/** The two buckets and the address the public one is read at (DDD 16.1). */
export interface R2Buckets {
  privateBucket: string;
  publicBucket: string;
  /** For example `https://pub-….r2.dev` or the CDN domain, with no trailing slash. */
  publicBaseUrl: string;
}

/** What the R2 client needs: the account's S3 address and an access key made for the buckets. */
export interface R2Access {
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
}

/**
 * An S3 client for R2. It adds a checksum only where one is required: by default the SDK would put the checksum of
 * an empty body into a presigned address, and R2 would then refuse the real file.
 */
export function createR2Client(access: R2Access): S3Client {
  return new S3Client({
    region: 'auto',
    endpoint: access.endpoint,
    forcePathStyle: true,
    credentials: { accessKeyId: access.accessKeyId, secretAccessKey: access.secretAccessKey },
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
}

/**
 * Cloudflare R2 through its S3 interface (decision of 8 Nov 2026). R2 has no presigned POST policy, so an upload ticket
 * is a presigned PUT that is signed for the type, the exact size and "only if nothing is there yet": the client must
 * send those headers, and a second send to the same key never replaces an object. The server still reads what arrived
 * at confirm (API design 15.1). Private objects are read through five-minute links; public ones at `publicUrl`.
 */
export class R2ObjectStorage extends ObjectStorage {
  constructor(
    private readonly client: S3Client,
    private readonly buckets: R2Buckets,
    private readonly clock: Clock,
  ) {
    super();
  }

  async createUpload(input: {
    key: string;
    contentType: string;
    sizeBytes: number;
    maxBytes: number;
    expiresAt: Date;
  }): Promise<UploadTicket> {
    const headers = {
      'content-type': input.contentType,
      'content-length': String(input.sizeBytes),
      'if-none-match': '*',
    };
    const url = await getSignedUrl(
      this.client,
      new PutObjectCommand({
        Bucket: this.bucketOf(input.key),
        Key: input.key,
        ContentType: input.contentType,
        ContentLength: input.sizeBytes,
        IfNoneMatch: '*',
      }),
      {
        expiresIn: this.secondsUntil(input.expiresAt),
        signableHeaders: new Set(Object.keys(headers)),
      },
    );
    return { url, method: 'PUT', fields: {}, headers, expiresAt: input.expiresAt };
  }

  async createDownload(input: {
    key: string;
    contentType: string;
    fileName: string | null;
    expiresAt: Date;
  }): Promise<DownloadTicket> {
    const url = await getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: this.bucketOf(input.key),
        Key: input.key,
        ResponseContentType: input.contentType,
        ResponseContentDisposition: attachmentDisposition(input.fileName),
      }),
      { expiresIn: this.secondsUntil(input.expiresAt) },
    );
    return { url, expiresAt: input.expiresAt };
  }

  /** At most one byte past the largest file, so an object that is too large shows as too large and costs no more. */
  async read(key: string): Promise<Buffer | null> {
    try {
      const answer = await this.client.send(
        new GetObjectCommand({
          Bucket: this.bucketOf(key),
          Key: key,
          Range: `bytes=0-${MAX_FILE_BYTES}`,
        }),
      );
      return Buffer.from((await answer.Body?.transformToByteArray()) ?? []);
    } catch (error) {
      if (error instanceof NoSuchKey) return null;
      throw error;
    }
  }

  async remove(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucketOf(key), Key: key }));
  }

  publicUrl(key: string): string {
    return `${this.buckets.publicBaseUrl}/${key}`;
  }

  private bucketOf(key: string): string {
    return isPublicKey(key) ? this.buckets.publicBucket : this.buckets.privateBucket;
  }

  private secondsUntil(at: Date): number {
    return Math.max(1, Math.ceil((at.getTime() - this.clock.now().getTime()) / 1000));
  }
}
