// Independently drawn Aipet mark. No CrossPet artwork is used in the application icon.
import { deflateSync } from 'node:zlib';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let crc = n;
  for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(kind, bytes) {
  const name = Buffer.from(kind, 'ascii');
  const size = Buffer.alloc(4);
  size.writeUInt32BE(bytes.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([name, bytes])));
  return Buffer.concat([size, name, bytes, checksum]);
}
function ellipse(x, y, cx, cy, rx, ry, rotation = 0) {
  const dx = x - cx, dy = y - cy;
  const u = dx * Math.cos(rotation) + dy * Math.sin(rotation);
  const v = -dx * Math.sin(rotation) + dy * Math.cos(rotation);
  return (u / rx) ** 2 + (v / ry) ** 2 <= 1;
}
function color(x, y) {
  const edgeX = Math.max(Math.abs(x - 0.5) - 0.31, 0);
  const edgeY = Math.max(Math.abs(y - 0.5) - 0.31, 0);
  if (Math.hypot(edgeX, edgeY) > 0.145) return [0, 0, 0, 0];
  const glow = Math.max(0, 1 - Math.hypot((x - 0.33) * 1.2, y - 0.25) * 1.6);
  let rgba = [Math.round(20 + glow * 18), Math.round(23 + glow * 16), Math.round(36 + glow * 32), 255];
  // A warm lavender paw, with four toes and a softly scalloped pad.
  const toe = ellipse(x, y, 0.295, 0.425, 0.063, 0.09, -0.35)
    || ellipse(x, y, 0.422, 0.32, 0.065, 0.095, -0.1)
    || ellipse(x, y, 0.572, 0.325, 0.065, 0.095, 0.14)
    || ellipse(x, y, 0.697, 0.435, 0.06, 0.085, 0.38);
  const pad = ellipse(x, y, 0.492, 0.59, 0.175, 0.135)
    || ellipse(x, y, 0.408, 0.64, 0.09, 0.08)
    || ellipse(x, y, 0.577, 0.64, 0.09, 0.08);
  if (toe || pad) rgba = [Math.round(202 + (1 - y) * 24), Math.round(181 + (1 - y) * 20), 255, 255];
  // A four-point mint spark emphasizes the companion's AI activity.
  const sx = Math.abs(x - 0.77), sy = Math.abs(y - 0.235);
  if ((sx / 0.075) ** 0.6 + (sy / 0.09) ** 0.6 < 1) rgba = [168, 235, 219, 255];
  return rgba;
}
function png(size) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  const samples = 4;
  for (let y = 0; y < size; y++) {
    const offset = y * (size * 4 + 1);
    raw[offset] = 0;
    for (let x = 0; x < size; x++) {
      const total = [0, 0, 0, 0];
      for (let sy = 0; sy < samples; sy++) for (let sx = 0; sx < samples; sx++) {
        const rgba = color((x + (sx + 0.5) / samples) / size, (y + (sy + 0.5) / samples) / size);
        total[3] += rgba[3];
        for (let c = 0; c < 3; c++) total[c] += rgba[c] * rgba[3] / 255;
      }
      const alpha = total[3] / samples ** 2;
      for (let c = 0; c < 3; c++) raw[offset + 1 + x * 4 + c] = alpha ? Math.round(total[c] / samples ** 2 * 255 / alpha) : 0;
      raw[offset + 4 + x * 4] = Math.round(alpha);
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

export async function makeIcon() {
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const images = sizes.map(size => ({ size, bytes: png(size) }));
  const header = Buffer.alloc(6 + images.length * 16);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  for (let index = 0; index < images.length; index++) {
    const { size, bytes } = images[index];
    const position = 6 + index * 16;
    header[position] = header[position + 1] = size === 256 ? 0 : size;
    header.writeUInt16LE(1, position + 4);
    header.writeUInt16LE(32, position + 6);
    header.writeUInt32LE(bytes.length, position + 8);
    header.writeUInt32LE(offset, position + 12);
    offset += bytes.length;
  }
  await mkdir(path.join(root, 'renderer'), { recursive: true });
  await writeFile(path.join(root, 'renderer', 'icon.png'), images.at(-1).bytes);
  await writeFile(path.join(root, 'renderer', 'icon.ico'), Buffer.concat([header, ...images.map(image => image.bytes)]));
  console.log('Created independent Aipet paw icon (PNG and seven-size Windows ICO).');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await makeIcon();
