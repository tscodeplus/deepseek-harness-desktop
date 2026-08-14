// copy-sidecar-static.cjs — copy non-compiled assets into the sidecar staging
// dir (.sidecar-deps/root/) after `tsc -p sidecar/tsconfig.json`:
//   · package.json ({"type":"module"} + engines, needed for ESM resolution
//                   since the installed tree has no ancestor package.json)

const fs = require('fs');
const path = require('path');

const DESKTOP = path.resolve(__dirname, '..');
const SRC = path.join(DESKTOP, 'sidecar');
const OUT = path.join(DESKTOP, '.sidecar-deps', 'root');

fs.mkdirSync(OUT, { recursive: true });
fs.copyFileSync(path.join(SRC, 'package.json'), path.join(OUT, 'package.json'));
console.log(`[copy-sidecar-static] copied ${OUT}`);
