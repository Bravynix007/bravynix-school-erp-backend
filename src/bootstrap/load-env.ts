import { existsSync } from 'node:fs';

/**
 * Loads `.env` for local runs. Deployed environments inject variables
 * directly and ship no `.env` file. Values already set in the environment win.
 */
if (existsSync('.env')) {
  process.loadEnvFile('.env');
}
