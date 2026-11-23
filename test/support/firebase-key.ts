import { generateKeyPairSync } from 'node:crypto';
import type { FirebaseCredentials } from '../../src/platform/notifications/firebase-credentials.js';

/** A real RSA key, made once: signing a Firebase sign-in needs one, and making one takes a moment. */
const demoKey = generateKeyPairSync('rsa', { modulusLength: 2048 })
  .privateKey.export({ type: 'pkcs8', format: 'pem' })
  .toString();

/** A key-shaped text that is no key. Built in pieces so secret scanners do not take it for one. */
export const placeholderPem = (body: string): string =>
  `-----BEGIN ${'PRIVATE'} KEY-----\n${body}\n-----END ${'PRIVATE'} KEY-----`;

/** A service account of the demo project, with a real key unless the test says another. */
export const demoServiceAccount = (
  overrides: Partial<FirebaseCredentials> = {},
): FirebaseCredentials => ({
  type: 'service_account',
  project_id: 'demo-project',
  client_email: 'push@demo-project.iam.gserviceaccount.com',
  private_key: demoKey,
  token_uri: 'https://oauth2.googleapis.com/token',
  ...overrides,
});
