import { Logger } from '@nestjs/common';
import { SignJWT, importPKCS8, type CryptoKey } from 'jose';
import type { Clock } from '../../common/time/clock.js';
import type { FirebaseCredentials } from './firebase-credentials.js';
import type { PushMessage, PushOutcome } from './push-sender.js';
import { PushSender } from './push-sender.js';

const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
/** Sends in flight at once: FCM v1 takes one message a call. */
const CONCURRENCY = 20;
/** A call that gets no answer in this time is given up (SDD 18: outbound calls have timeouts). */
const TIMEOUT_MS = 10_000;
/** Tries a push gets when FCM or the network is passing-faulty (429, 5xx, no answer): SDD 18, up to 5 with back-off. After that the inbox is the record. */
const ATTEMPTS = 5;
const BACKOFF_MS = 250;
/** What FCM answers for a token that is no phone's: gone, or issued to another Firebase project. */
const GONE_CODES = new Set(['UNREGISTERED', 'SENDER_ID_MISMATCH']);

/** What the driver needs from outside, so a test can answer for Google. */
export interface FirebaseTransport {
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
}

const REAL_TRANSPORT: FirebaseTransport = {
  fetch: (input, init) => fetch(input, init),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

interface FcmError {
  error?: {
    status?: string;
    details?: {
      errorCode?: string;
      fieldViolations?: { field?: string }[];
    }[];
  };
}

/**
 * Firebase Cloud Messaging over its HTTP v1 API (SDD 18), signed in with the service account of the project. The
 * title and text are the inbox text; the only other thing sent is the screen to open, never a mark, an amount or an
 * ID. A token FCM says is gone is reported so the worker removes it; any other fault leaves the token, and the inbox
 * row already holds the notice. Nothing the push says, and no token, is ever logged.
 */
export class FirebasePushSender extends PushSender {
  private readonly logger = new Logger(FirebasePushSender.name);
  private key: Promise<CryptoKey> | undefined;
  private access: { token: string; expiresAt: number } | undefined;

  constructor(
    private readonly credentials: FirebaseCredentials,
    private readonly clock: Clock,
    private readonly transport: FirebaseTransport = REAL_TRANSPORT,
  ) {
    super();
  }

  /** Reads the private key, so a key that cannot be used stops the start and is not found at the first notice. */
  async checkKey(): Promise<void> {
    this.key ??= importPKCS8(this.credentials.private_key, 'RS256');
    await this.key;
  }

  async send(messages: PushMessage[]): Promise<PushOutcome[]> {
    // The sign-in is made once for the whole batch, so a provider that cannot be reached at all throws here.
    const token = await this.accessToken();
    const outcomes: PushOutcome[] = Array.from({ length: messages.length }, () => 'failed');
    for (let from = 0; from < messages.length; from += CONCURRENCY) {
      const slice = messages.slice(from, from + CONCURRENCY);
      const results = await Promise.all(slice.map((message) => this.sendOne(token, message)));
      results.forEach((outcome, index) => {
        outcomes[from + index] = outcome;
      });
    }
    const failed = outcomes.filter((outcome) => outcome === 'failed').length;
    if (failed > 0) this.logger.warn({ count: messages.length, failed }, 'Some pushes failed');
    return outcomes;
  }

  private async sendOne(accessToken: string, message: PushMessage): Promise<PushOutcome> {
    const url = `https://fcm.googleapis.com/v1/projects/${this.credentials.project_id}/messages:send`;
    for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
      try {
        const response = await this.transport.fetch(url, {
          method: 'POST',
          headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
          body: JSON.stringify(body(message)),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (response.ok) return 'sent';
        if (response.status === 429 || response.status >= 500) {
          if (attempt < ATTEMPTS) {
            await this.transport.sleep(BACKOFF_MS * 2 ** (attempt - 1));
            continue;
          }
          return 'failed';
        }
        return isGone((await response.json().catch(() => ({}))) as FcmError)
          ? 'invalid_token'
          : 'failed';
      } catch {
        if (attempt < ATTEMPTS) {
          await this.transport.sleep(BACKOFF_MS * 2 ** (attempt - 1));
          continue;
        }
        return 'failed';
      }
    }
    return 'failed';
  }

  /** An OAuth token for FCM, kept until a minute before it ends. */
  private async accessToken(): Promise<string> {
    const now = this.clock.now().getTime();
    if (this.access && this.access.expiresAt - 60_000 > now) return this.access.token;
    const { client_email: email, token_uri: audience } = this.credentials;
    this.key ??= importPKCS8(this.credentials.private_key, 'RS256');
    const issued = Math.floor(now / 1000);
    const assertion = await new SignJWT({ scope: SCOPE })
      .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
      .setIssuer(email)
      .setSubject(email)
      .setAudience(audience)
      .setIssuedAt(issued)
      .setExpirationTime(issued + 3600)
      .sign(await this.key);
    const response = await this.transport.fetch(audience, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`Google refused the Firebase sign-in (${response.status})`);
    const grant = (await response.json()) as { access_token?: string; expires_in?: number };
    if (!grant.access_token) throw new Error('Google gave no Firebase access token');
    this.access = { token: grant.access_token, expiresAt: now + (grant.expires_in ?? 3600) * 1000 };
    return this.access.token;
  }
}

/** The FCM v1 message: the inbox text, and the screen the app opens on a tap. */
function body(message: PushMessage) {
  return {
    message: {
      token: message.token,
      notification: { title: message.title, body: message.body },
      data: { screen: 'inbox' },
      android: { priority: 'HIGH', notification: { channel_id: 'alerts' } },
      apns: { headers: { 'apns-priority': '10' }, payload: { aps: { sound: 'default' } } },
    },
  };
}

/**
 * Whether FCM says the token itself is no longer any phone's: unregistered, one of another Firebase project's, or
 * named in a field violation. A refusal that names no token (a 404 for a wrong project, say) is a fault of ours, and
 * it must never delete the tokens of a whole batch.
 */
function isGone(error: FcmError): boolean {
  const details = error.error?.details ?? [];
  if (details.some((detail) => GONE_CODES.has(detail.errorCode ?? ''))) return true;
  return (
    error.error?.status === 'INVALID_ARGUMENT' &&
    details.some((detail) =>
      (detail.fieldViolations ?? []).some((violation) => violation.field?.endsWith('token')),
    )
  );
}
