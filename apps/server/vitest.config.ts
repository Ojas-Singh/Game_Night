import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The socket integration tests assert real-time behaviour (agent think
    // delays, presence debounce) on a shared in-process event loop. Running
    // test files in parallel starves those timers and makes the integration
    // suite flaky; sequential files keep the timing honest.
    fileParallelism: false,
  },
});
