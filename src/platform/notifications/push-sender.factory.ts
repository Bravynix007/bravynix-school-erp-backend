import { readFileSync } from 'node:fs';
import type { Clock } from '../../common/time/clock.js';
import type { Env } from '../../config/env.schema.js';
import { parseFirebaseCredentials } from './firebase-credentials.js';
import { FirebasePushSender } from './firebase-push-sender.js';
import { LogPushSender, type PushSender } from './push-sender.js';

/**
 * The push driver `PUSH_DRIVER` names. The Firebase key comes from the JSON text or from a file, an empty setting
 * counting as unset as the schema reads it; a key that cannot be used stops the start, not the first notice.
 */
export async function createPushSender(
  env: Pick<Env, 'PUSH_DRIVER' | 'FIREBASE_SERVICE_ACCOUNT_JSON' | 'FIREBASE_SERVICE_ACCOUNT_FILE'>,
  clock: Clock,
): Promise<PushSender> {
  if (env.PUSH_DRIVER !== 'firebase') return new LogPushSender();
  const text =
    env.FIREBASE_SERVICE_ACCOUNT_JSON || readFileSync(env.FIREBASE_SERVICE_ACCOUNT_FILE!, 'utf8');
  const sender = new FirebasePushSender(parseFirebaseCredentials(text), clock);
  await sender.checkKey();
  return sender;
}
