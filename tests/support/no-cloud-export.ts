/**
 * Test preload: no test exports Mozaik loop events to Mozaik Cloud unless
 * `FACTORY_TEST_MOZAIK_CLOUD=1` asks for it (a live smoke with the cloud
 * on). The cloud client reads its key from the environment first and the
 * `.env` file second, so the key names are set to empty strings, which it
 * treats as no key, rather than deleted.
 */

if (process.env['FACTORY_TEST_MOZAIK_CLOUD'] !== '1') {
  for (const name of ['MOZAIK_API_KEY', 'MOZAIK_PROJECT_KEY']) process.env[name] = '';
}
