/**
 * Lambda entry (started by run.sh): when SSM_PREFIX is set, copy the settings
 * stored under it into process.env, then start the unchanged server bundle.
 * The server reads its config when it loads, so this must run first.
 */
import { loadParameters, type GetByPath } from './ssm';

const prefix = process.env.SSM_PREFIX?.trim();
if (prefix) {
  try {
    const sdk = '@aws-sdk/client-ssm';
    const { SSMClient, GetParametersByPathCommand } = (await import(sdk)) as {
      SSMClient: new (cfg: object) => { send(cmd: unknown): Promise<{ Parameters?: { Name?: string; Value?: string }[]; NextToken?: string }> };
      GetParametersByPathCommand: new (input: object) => unknown;
    };
    const client = new SSMClient({});
    const getByPath: GetByPath = (Path, NextToken) => client.send(new GetParametersByPathCommand({ Path, NextToken, WithDecryption: true, Recursive: false }));
    const names = await loadParameters(getByPath, prefix);
    console.log(`config: ${names.length} settings loaded from SSM ${prefix} (${names.join(', ')})`);
  } catch (e) {
    // Without these settings accounts stay off, but the planner still works.
    console.error(`config: could not load SSM ${prefix}: ${(e as Error).name}: ${(e as Error).message}`);
  }
}

const entry = './server.js';
await import(entry);
