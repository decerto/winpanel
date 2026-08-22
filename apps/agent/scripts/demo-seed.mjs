/**
 * Seeds a demo database for screenshots, then exits.
 *
 * Run as `node scripts/demo-seed.mjs` from the repo root. The script sets
 * the environment before importing the agent modules, so the config picks up
 * the demo paths rather than the real install ones.
 */
import { execSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const root = path.join(os.tmpdir(), 'winpanel-demo');
const dataDir = path.join(root, 'data');
const serversDir = path.join(root, 'servers');

fs.rmSync(root, { recursive: true, force: true });
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(serversDir, { recursive: true });

const env = {
  ...process.env,
  WINPANEL_DATA_DIR: dataDir,
  WINPANEL_GAME_SERVERS_ROOT: serversDir,
  WINPANEL_PORT: '18443',
  WINPANEL_HTTPS: 'false',
};

// Run the bootstrap with the demo environment. The bootstrap sets up the
// database and seeds the demo data, then exits.
execSync('node dist/bootstrap-cli.js demo-seed', {
  env,
  stdio: 'inherit',
  cwd: path.resolve(import.meta.dirname, '..'),
});

console.log(`Demo data written to ${root}`);
console.log('Start the agent with the same environment to serve the panel:');
console.log(`  set WINPANEL_DATA_DIR=${dataDir}`);
console.log(`  set WINPANEL_GAME_SERVERS_ROOT=${serversDir}`);
console.log(`  set WINPANEL_PORT=18443`);
console.log(`  set WINPANEL_HTTPS=false`);
console.log(`  node apps/agent/dist/index.js`);
