import { z } from 'zod';

/** The parts of a Google service-account key the push driver uses. */
const serviceAccountSchema = z.object({
  type: z.literal('service_account'),
  project_id: z.string().min(1),
  client_email: z.string().min(1),
  private_key: z.string().includes('PRIVATE KEY'),
  token_uri: z.string().url().default('https://oauth2.googleapis.com/token'),
});

export type FirebaseCredentials = z.infer<typeof serviceAccountSchema>;

/**
 * Reads a service-account key from its JSON text. It names what is wrong, never what the key says: the text holds a
 * private key, so no part of it goes into the error (SDD 17.1).
 */
export function parseFirebaseCredentials(text: string): FirebaseCredentials {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error('The Firebase service account is not JSON');
  }
  const result = serviceAccountSchema.safeParse(json);
  if (!result.success) {
    const fields = result.error.issues.map((issue) => issue.path.join('.')).join(', ');
    throw new Error(`The Firebase service account is not a service-account key (check: ${fields})`);
  }
  return result.data;
}
