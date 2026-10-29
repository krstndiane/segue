import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const env = { ...loadEnv(mode, process.cwd(), 'VITE_'), ...process.env };
  return {
    plugins: [react()],
    server: { port: 5173 },
    build: { target: 'es2022', sourcemap: true },
    // A constant, so a build without the assistant leaves its code out entirely (see src/lib/features.ts).
    define: { __SEGUE_ASSISTANT__: JSON.stringify(env.VITE_ASSISTANT === 'on') },
  };
});
