/** Hosts a seed may write to: this machine and the docker compose service. */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', 'postgres']);

/**
 * Seed data must never reach a shared database. NODE_ENV alone is not enough,
 * because it is easy to leave unset while DATABASE_URL points elsewhere, so
 * the database host must also be local (QA Phase 0 B12).
 */
export function assertSeedable(databaseUrl: string, nodeEnv: string | undefined): void {
  if (nodeEnv === 'staging' || nodeEnv === 'production') {
    throw new Error('Seeding is refused in staging and production');
  }
  let host: string;
  try {
    host = new URL(databaseUrl).hostname.toLowerCase();
  } catch {
    throw new Error('The database URL is not a valid URL');
  }
  if (!LOCAL_HOSTS.has(host)) {
    throw new Error(`Seeding is refused for database host "${host}": only local databases`);
  }
}
