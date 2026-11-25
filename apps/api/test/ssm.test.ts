import { describe, expect, it } from 'vitest';
import { loadParameters, type GetByPath } from '../src/lambda/ssm';

describe('loadParameters (SSM preload)', () => {
  it('maps /segue/NAME to NAME across pages, asks for the path without a trailing slash, and returns the names set', async () => {
    const asked: [string, string | undefined][] = [];
    const pages: Record<string, { Parameters: { Name: string; Value: string }[]; NextToken?: string }> = {
      first: { Parameters: [{ Name: '/segue/DATABASE_URL', Value: 'postgres://x' }, { Name: '/segue/SUPABASE_URL', Value: 'https://y' }], NextToken: 'p2' },
      p2: { Parameters: [{ Name: '/segue/GOOGLE_TOKEN_KEY', Value: 'k' }] },
    };
    const get: GetByPath = async (path, next) => {
      asked.push([path, next]);
      return pages[next ?? 'first']!;
    };
    const env: NodeJS.ProcessEnv = {};
    const names = await loadParameters(get, '/segue/', env);
    expect(asked).toEqual([['/segue', undefined], ['/segue', 'p2']]);
    expect(names).toEqual(['DATABASE_URL', 'GOOGLE_TOKEN_KEY', 'SUPABASE_URL']);
    expect(env).toEqual({ DATABASE_URL: 'postgres://x', SUPABASE_URL: 'https://y', GOOGLE_TOKEN_KEY: 'k' });
  });

  it("keeps the Lambda's own settings and skips names that are not environment variable names", async () => {
    const get: GetByPath = async () => ({
      Parameters: [
        { Name: '/segue/MIGRATE_ON_START', Value: 'on' },
        { Name: '/segue/lower_case', Value: 'x' },
        { Name: '/segue/nested/THING', Value: 'x' },
        { Name: '/segue/CORS_ORIGINS', Value: 'https://segue.pdyntech.com' },
      ],
    });
    const env: NodeJS.ProcessEnv = { MIGRATE_ON_START: 'off' };
    const names = await loadParameters(get, '/segue', env);
    expect(names).toEqual(['CORS_ORIGINS']);
    expect(env.MIGRATE_ON_START).toBe('off');
    expect(env.lower_case).toBeUndefined();
  });
});
