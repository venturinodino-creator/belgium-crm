// Smoke check configuration. Run with `npm test`.
const PORT = Number(process.env.PORT || 4173);

module.exports = {
  testDir: 'tests',
  timeout: 60000,
  fullyParallel: true,
  // Each test loads the whole 800 KB page; more workers than this starves them.
  workers: process.env.CI ? 2 : 4,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    browserName: 'chromium',
    viewport: { width: 1440, height: 900 },
  },
  webServer: {
    command: 'node tests/support/static-server.js',
    url: `http://127.0.0.1:${PORT}/index.html`,
    reuseExistingServer: !process.env.CI,
  },
};
