import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { readCustomArtwork } = require('../src/core/artwork.cjs');
const directory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../assets/custom');
const result = readCustomArtwork(directory, { strict: true, verifyInventory: true });
console.log(`Verified ${result.posesVerified} custom poses and ${result.files.length} pinned custom artwork files (including manifest).`);
