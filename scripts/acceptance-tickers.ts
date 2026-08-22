// Thin shim - the ticker acceptance suite now lives in scripts/acceptance/suites/tickers.ts
// as part of the consolidated harness (scripts/acceptance.ts). Kept so the documented
// command below keeps working unchanged.
//
//   npx tsx scripts/acceptance-tickers.ts
//
// See scripts/acceptance.ts for full env/requirements documentation.

process.argv = [process.argv[0], process.argv[1], 'tickers'];
import('./acceptance');
