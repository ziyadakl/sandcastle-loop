// Reference copy of the timeouts a project's vitest config sets. See README.txt.
// Read as TEXT by lib/harness/timeout-budget-contract.test.ts.
export default {
  test: {
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
};
