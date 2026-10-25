import { defineConfig } from 'vitest/config';

// The database tests share one `segue` schema, so test files run one after another.
export default defineConfig({ test: { fileParallelism: false } });
