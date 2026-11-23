import { parseFirebaseCredentials } from './firebase-credentials.js';

const key = {
  type: 'service_account',
  project_id: 'demo-project',
  client_email: 'push@demo-project.iam.gserviceaccount.com',
  private_key: '-----BEGIN PRIVATE KEY-----\nSECRET-BODY\n-----END PRIVATE KEY-----\n',
};

describe('parseFirebaseCredentials', () => {
  it('reads a service-account key and fills in the Google token address', () => {
    const credentials = parseFirebaseCredentials(JSON.stringify(key));
    expect(credentials.project_id).toBe('demo-project');
    expect(credentials.token_uri).toBe('https://oauth2.googleapis.com/token');
  });

  it('keeps the token address the key names', () => {
    const credentials = parseFirebaseCredentials(
      JSON.stringify({ ...key, token_uri: 'https://auth.example.test/token' }),
    );
    expect(credentials.token_uri).toBe('https://auth.example.test/token');
  });

  it('refuses text that is not JSON without echoing it', () => {
    expect(() => parseFirebaseCredentials('PRIVATE KEY not json')).toThrow(
      'The Firebase service account is not JSON',
    );
  });

  it('names the fields that are wrong, never their values', () => {
    const wrong = JSON.stringify({ ...key, private_key: 'SECRET-BODY', type: 'user' });
    expect(() => parseFirebaseCredentials(wrong)).toThrow(/check: type, private_key/);
    expect(() => parseFirebaseCredentials(wrong)).not.toThrow(/SECRET-BODY/);
  });
});
