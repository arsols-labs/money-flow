import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = new URL('../', import.meta.url);
const output = new URL('public/icons/', root);

await mkdir(output, { recursive: true });

async function processTheme(theme, sourceFile, getBgColor) {
  const masterJpg = fileURLToPath(new URL(sourceFile, output));
  const { data, info } = await sharp(masterJpg).raw().toBuffer({ resolveWithObject: true });
  const w = info.width, h = info.height, ch = info.channels;

  // The icon squircle is 944x944 centered at (40, 40)
  const cropX = 40, cropY = 40, cropW = 944, cropH = 944;
  const cx = cropW / 2, cy = cropH / 2;
  const a = cx, b = cy;

  const standardBuffer = Buffer.alloc(cropW * cropH * 4);
  const maskableBuffer = Buffer.alloc(cropW * cropH * 4);

  for (let y = 0; y < cropH; y++) {
    const t = y / cropH;
    const [bgR, bgG, bgB] = getBgColor(t);

    for (let x = 0; x < cropW; x++) {
      const targetIdx = (y * cropW + x) * 4;
      const srcIdx = ((y + cropY) * w + (x + cropX)) * ch;

      const dx = Math.abs(x - cx) / a;
      const dy = Math.abs(y - cy) / b;
      // Superellipse distance metric for iOS squircle curvature
      const val = Math.pow(dx, 5.5) + Math.pow(dy, 5.5);

      // 1. Standard icon: transparent outside squircle with smooth anti-aliased edge
      if (val <= 0.98) {
        standardBuffer[targetIdx] = data[srcIdx];
        standardBuffer[targetIdx + 1] = data[srcIdx + 1];
        standardBuffer[targetIdx + 2] = data[srcIdx + 2];
        standardBuffer[targetIdx + 3] = 255;
      } else if (val >= 1.02) {
        standardBuffer[targetIdx] = 0;
        standardBuffer[targetIdx + 1] = 0;
        standardBuffer[targetIdx + 2] = 0;
        standardBuffer[targetIdx + 3] = 0;
      } else {
        const alpha = Math.round(255 * (1 - (val - 0.98) / (1.02 - 0.98)));
        standardBuffer[targetIdx] = data[srcIdx];
        standardBuffer[targetIdx + 1] = data[srcIdx + 1];
        standardBuffer[targetIdx + 2] = data[srcIdx + 2];
        standardBuffer[targetIdx + 3] = alpha;
      }

      // 2. Maskable icon: full-bleed opaque square with corners blended into the background field
      if (val <= 0.92) {
        maskableBuffer[targetIdx] = data[srcIdx];
        maskableBuffer[targetIdx + 1] = data[srcIdx + 1];
        maskableBuffer[targetIdx + 2] = data[srcIdx + 2];
        maskableBuffer[targetIdx + 3] = 255;
      } else if (val >= 1.02) {
        maskableBuffer[targetIdx] = bgR;
        maskableBuffer[targetIdx + 1] = bgG;
        maskableBuffer[targetIdx + 2] = bgB;
        maskableBuffer[targetIdx + 3] = 255;
      } else {
        const blend = (val - 0.92) / (1.02 - 0.92);
        maskableBuffer[targetIdx] = Math.round(data[srcIdx] * (1 - blend) + bgR * blend);
        maskableBuffer[targetIdx + 1] = Math.round(data[srcIdx + 1] * (1 - blend) + bgG * blend);
        maskableBuffer[targetIdx + 2] = Math.round(data[srcIdx + 2] * (1 - blend) + bgB * blend);
        maskableBuffer[targetIdx + 3] = 255;
      }
    }
  }

  const standardRaw = sharp(standardBuffer, { raw: { width: cropW, height: cropH, channels: 4 } });
  const maskableRaw = sharp(maskableBuffer, { raw: { width: cropW, height: cropH, channels: 4 } });

  // Save master source-glow-${theme}.png (512x512)
  await standardRaw.clone().resize(512, 512).png({ compressionLevel: 9 }).toFile(new URL(`source-glow-${theme}.png`, output).pathname);

  // Standard launcher PNGs: 32, 192, 512
  for (const size of [32, 192, 512]) {
    const pngBuffer = await standardRaw.clone().resize(size, size).png({ compressionLevel: 9 }).toBuffer();
    await writeFile(new URL(`icon-${theme}-${size}.png`, output), pngBuffer);
  }

  // Maskable PNGs: 192, 512
  for (const size of [192, 512]) {
    const maskablePngBuffer = await maskableRaw.clone().resize(size, size).png({ compressionLevel: 9 }).toBuffer();
    await writeFile(new URL(`maskable-${theme}-${size}.png`, output), maskablePngBuffer);
  }

  // Apple touch icon: 180x180 full bleed opaque
  const appleTouchBuffer = await maskableRaw.clone().resize(180, 180).png({ compressionLevel: 9 }).toBuffer();
  await writeFile(new URL(`apple-touch-${theme}.png`, output), appleTouchBuffer);

  // SVGs embedding 512x512 high-res artwork
  const standard512Png = await standardRaw.clone().resize(512, 512).png({ compressionLevel: 9 }).toBuffer();
  const maskable512Png = await maskableRaw.clone().resize(512, 512).png({ compressionLevel: 9 }).toBuffer();

  const standardBase64 = standard512Png.toString('base64');
  const maskableBase64 = maskable512Png.toString('base64');

  const standardSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <title>Money Flow</title>
  <image href="data:image/png;base64,${standardBase64}" width="512" height="512"/>
</svg>
`;
  const maskableSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <title>Money Flow</title>
  <image href="data:image/png;base64,${maskableBase64}" width="512" height="512"/>
</svg>
`;

  await writeFile(new URL(`icon-${theme}.svg`, output), standardSvg);
  await writeFile(new URL(`maskable-${theme}.svg`, output), maskableSvg);

  return { standardBase64, maskableBase64 };
}

// 1. Process Dark Theme
const darkResults = await processTheme('dark', 'source-gemini-master.jpg', (t) => [
  Math.round(17 * (1 - t) + 3 * t),
  Math.round(24 * (1 - t) + 8 * t),
  Math.round(38 * (1 - t) + 18 * t),
]);

// 2. Process Light Theme
const lightResults = await processTheme('light', 'source-gemini-light.jpg', (t) => [
  Math.round(249 * (1 - t) + 234 * t),
  Math.round(249 * (1 - t) + 239 * t),
  Math.round(251 * (1 - t) + 243 * t),
]);

// 3. Adaptive icon.svg switching based on prefers-color-scheme
const adaptiveSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <title>Money Flow</title>
  <style>
    .theme-light { display: none; }
    @media (prefers-color-scheme: light) {
      .theme-dark { display: none; }
      .theme-light { display: inline; }
    }
  </style>
  <image class="theme-dark" href="data:image/png;base64,${darkResults.standardBase64}" width="512" height="512"/>
  <image class="theme-light" href="data:image/png;base64,${lightResults.standardBase64}" width="512" height="512"/>
</svg>
`;
await writeFile(new URL('icon.svg', output), adaptiveSvg);

console.log('Successfully generated Dark and Light Money Flow app icons from Gemini master artworks in public/icons/');
