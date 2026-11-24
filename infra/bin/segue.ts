import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { App } from 'aws-cdk-lib';
import { SegueApiStack } from '../lib/api-stack';

const here = dirname(fileURLToPath(import.meta.url));
const assetDir = resolve(here, '../.build/api');
if (!existsSync(resolve(assetDir, 'server.js'))) {
  throw new Error('Lambda package missing. Run "pnpm --filter @segue/infra package" first (the synth, diff and deploy scripts do it for you).');
}

const app = new App();
// The Organization's SCP only allows ap-southeast-2 for this account (Stage 1 decision record).
new SegueApiStack(app, 'SegueApi', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: 'ap-southeast-2' },
  assetDir,
  adapterLayerVersion: Number(app.node.tryGetContext('lambdaWebAdapterLayerVersion') ?? 30),
  description: 'Segue API on Lambda behind an HTTP API (AWS SCD Mindanao 2026 slice).',
});
