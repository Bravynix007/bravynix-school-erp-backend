import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FixedClock } from '../../common/time/clock.js';
import { FirebasePushSender } from './firebase-push-sender.js';
import { LogPushSender } from './push-sender.js';
import { createPushSender } from './push-sender.factory.js';

// Built in pieces so secret scanners do not take the placeholder for a key.
const brokenPem = `-----BEGIN ${'PRIVATE'} KEY-----\nnot a key\n-----END ${'PRIVATE'} KEY-----`;

const keyText = (privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey) =>
  JSON.stringify({
    type: 'service_account',
    project_id: 'demo-project',
    client_email: 'push@demo-project.iam.gserviceaccount.com',
    private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  });

describe('createPushSender', () => {
  const clock = new FixedClock();
  let folder: string;
  beforeAll(() => {
    folder = mkdtempSync(join(tmpdir(), 'push-'));
  });
  afterAll(() => rmSync(folder, { recursive: true, force: true }));

  it('is the log driver unless PUSH_DRIVER says firebase', async () => {
    expect(await createPushSender({ PUSH_DRIVER: 'log' }, clock)).toBeInstanceOf(LogPushSender);
  });

  it('builds the Firebase driver from the JSON text', async () => {
    const sender = await createPushSender(
      { PUSH_DRIVER: 'firebase', FIREBASE_SERVICE_ACCOUNT_JSON: keyText() },
      clock,
    );
    expect(sender).toBeInstanceOf(FirebasePushSender);
  });

  it('builds the Firebase driver from a file, and an empty JSON setting counts as unset', async () => {
    const file = join(folder, 'key.json');
    writeFileSync(file, keyText());
    const sender = await createPushSender(
      {
        PUSH_DRIVER: 'firebase',
        FIREBASE_SERVICE_ACCOUNT_JSON: '',
        FIREBASE_SERVICE_ACCOUNT_FILE: file,
      },
      clock,
    );
    expect(sender).toBeInstanceOf(FirebasePushSender);
  });

  it('stops the start for a key that cannot be used, without echoing it', async () => {
    const broken = JSON.stringify({
      ...JSON.parse(keyText()),
      private_key: brokenPem,
    });
    const attempt = createPushSender(
      { PUSH_DRIVER: 'firebase', FIREBASE_SERVICE_ACCOUNT_JSON: broken },
      clock,
    );
    const error = await attempt.then(
      () => new Error('started'),
      (failure: unknown) => failure as Error,
    );
    expect(error.message).toMatch(/PKCS8|key/i);
    expect(error.message).not.toContain('not a key');
  });
});
