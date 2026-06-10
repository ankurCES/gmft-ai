import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 15_000,
    hookTimeout: 15_000,
    // Tests run on the host (no docker available in CI / dev sandboxes).
    // The runner's host-fallback path is what the tests exercise.
    env: {
      GMFT_SKIP_PREREQ: '1',
    },
  },
});
