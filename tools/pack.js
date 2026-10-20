// Packs the app back into dist/app.asar (+ dist/app.asar.unpacked), laid out like the original release:
// everything under resources/ and the PowerShell agents stay loose beside the archive, the rest goes inside.
// Drop both into the installed app's resources folder (%LOCALAPPDATA%\Programs\iJWA\resources) to use them.
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const root = path.join(__dirname, '..');
const dist = path.join(root, 'dist');
const stage = path.join(dist, 'stage');

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });
for (const entry of ['package.json', 'src', 'resources', 'node_modules']) {
  fs.cpSync(path.join(root, entry), path.join(stage, entry), { recursive: true });
}

// Keep the shipped package.json as it was: the dev scripts above don't belong in the release.
const pkg = JSON.parse(fs.readFileSync(path.join(stage, 'package.json'), 'utf8'));
delete pkg.scripts;
fs.writeFileSync(path.join(stage, 'package.json'), `${JSON.stringify(pkg, null, 2)}`);

execSync(`npx --yes @electron/asar@3.2.17 pack "${stage}" "${path.join(dist, 'app.asar')}" --unpack-dir resources --unpack "*.ps1"`,
  { stdio: 'inherit' });
fs.rmSync(stage, { recursive: true, force: true });
console.log(`Packed ${path.join(dist, 'app.asar')}`);
