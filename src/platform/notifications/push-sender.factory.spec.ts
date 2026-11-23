import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FixedClock } from '../../common/time/clock.js';
import { demoServiceAccount, placeholderPem } from '../../../test/support/firebase-key.js';
import { FirebasePushSender } from './firebase-push-sender.js';
import { LogPushSender } from './push-sender.js';
import { createPushSender } from './push-sender.factory.js';

const keyText = () => JSON.stringify(demoServiceAccount());

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
    const broken = JSON.stringify(demoServiceAccount({ private_key: placeholderPem('not a key') }));
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
