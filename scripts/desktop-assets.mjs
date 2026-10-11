import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const directory = path.resolve('native/Linchuan.Desktop/Assets');
await fs.mkdir(directory, { recursive: true });
for (const [language, country] of [
  ['zh', 'cn'],
  ['en', 'us'],
  ['ko', 'kr'],
  ['ja', 'jp'],
]) {
  await sharp(path.resolve(`node_modules/flag-icons/flags/4x3/${country}.svg`))
    .resize(44, 44, { fit: 'cover' })
    .png()
    .toFile(path.join(directory, `${language}.png`));
}
const image = await sharp(path.resolve('public/favicon.svg'))
  .resize(128, 128)
  .png()
  .toBuffer();
const header = Buffer.alloc(22);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(1, 4);
header[6] = 128;
header[7] = 128;
header.writeUInt16LE(1, 10);
header.writeUInt16LE(32, 12);
header.writeUInt32LE(image.length, 14);
header.writeUInt32LE(22, 18);
await fs.writeFile(
  path.join(directory, 'app.ico'),
  Buffer.concat([header, image]),
);
