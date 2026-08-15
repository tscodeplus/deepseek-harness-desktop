import { defineConfig } from 'vitest/config';

// Only run the sidecar's own unit tests. Without an explicit include, vitest
// globs the whole desktop tree — including src-tauri/target where tauri dev
// copies the dsh build closure (upstream's own lefthook/vitest suites).
export default defineConfig({
  test: {
    include: ['sidecar/test/**/*.test.ts'],
    exclude: [
      'node_modules/**',
      'src-tauri/target/**',
      '.dsh-build/**',
      '.sidecar-deps/**',
    ],
    environment: 'node',
  },
});
