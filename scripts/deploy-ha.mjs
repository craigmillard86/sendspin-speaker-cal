// Copy the integration into a Home Assistant config folder, for testing without HACS.
// Usage: npm run deploy:ha -- /path/to/homeassistant/config
// (for example a Samba share of HA OS mounted on this machine)
import { cpSync, existsSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

const config = process.argv[2];
if (!config) {
  console.error('Usage: npm run deploy:ha -- /path/to/homeassistant/config');
  process.exit(1);
}
const root = resolve(config);
if (!existsSync(join(root, 'configuration.yaml'))) {
  console.error(`${root} does not look like a Home Assistant config folder (no configuration.yaml).`);
  process.exit(1);
}
const source = resolve('custom_components/speaker_tuner');
const target = join(root, 'custom_components', 'speaker_tuner');
rmSync(target, { recursive: true, force: true });
cpSync(source, target, { recursive: true, filter: (p) => !p.includes('__pycache__') });
console.log(`Copied to ${target}.`);
console.log('Restart Home Assistant, then add the integration: Settings > Devices & services > Add integration > Speaker Tuner.');
