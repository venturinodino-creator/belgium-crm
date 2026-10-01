// Smoke check configuration. Run with `npm test`.
// An uncommon port on purpose: 4173 is a popular dev-server default, and a
// foreign server answering there made every test time out.
const PORT = Number(process.env.PORT || 41731);

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
    // Never reuse a server that is already listening: it may not be ours.
    reuseExistingServer: false,
  },
};
