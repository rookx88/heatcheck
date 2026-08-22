// Thin shim - the discovery acceptance suite now lives in
// scripts/acceptance/suites/discovery.ts as part of the consolidated harness
// (scripts/acceptance.ts). Kept so the documented command below keeps working unchanged.
//
//   npx tsx scripts/acceptance-discovery.ts
//
// See scripts/acceptance.ts for full env/requirements documentation.

process.argv = [process.argv[0], process.argv[1], 'discovery'];
import('./acceptance');
