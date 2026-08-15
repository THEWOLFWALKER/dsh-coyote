import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts'],
    environment: 'node',
    // Real sockets are exercised by the transport suite; give them room.
    testTimeout: 20_000,
    hookTimeout: 10_000,
  },
})
