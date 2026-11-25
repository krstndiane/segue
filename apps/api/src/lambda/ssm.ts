/**
 * Loads settings from SSM Parameter Store into process.env before the server
 * reads its config. /segue/DATABASE_URL becomes DATABASE_URL, and so on.
 * Values are never logged; only how many names were loaded.
 */

export interface SsmPage {
  Parameters?: { Name?: string; Value?: string }[];
  NextToken?: string;
}

/** Fetches one page of parameters under a path, decrypted. */
export type GetByPath = (path: string, nextToken?: string) => Promise<SsmPage>;

const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;

/**
 * Fills `env` from every parameter directly under `prefix`.
 * Settings already in `env` win (the Lambda's own configuration, e.g. MIGRATE_ON_START=off).
 * Returns the names it set.
 */
export async function loadParameters(getByPath: GetByPath, prefix: string, env: NodeJS.ProcessEnv = process.env): Promise<string[]> {
  const path = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
  const set: string[] = [];
  let next: string | undefined;
  do {
    const page = await getByPath(path, next);
    for (const p of page.Parameters ?? []) {
      const name = p.Name?.slice(path.length + 1) ?? '';
      if (!ENV_NAME.test(name) || p.Value === undefined) continue;
      if (env[name] !== undefined && env[name] !== '') continue;
      env[name] = p.Value;
      set.push(name);
    }
    next = page.NextToken;
  } while (next);
  return set.sort();
}
