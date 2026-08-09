// Generates all app/brand icons from a single square source image.
// Usage: node scripts/gen-icons.js <source.png>
const path = require('path');
const sharp = require('sharp');
const pngToIco = require('png-to-ico').default || require('png-to-ico');

const src = process.argv[2];
if (!src) {
  console.error('Usage: node scripts/gen-icons.js <source.png>');
  process.exit(1);
}

const root = path.join(__dirname, '..');

// Finds the smallest box that contains all visible pixels (alpha > threshold),
// so icons are cropped to the logo instead of shipping huge empty margins.
async function contentBounds(image) {
  const { data, info } = await image.raw().toBuffer({ resolveWithObject: true });
  const w = info.width, h = info.height;
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] > 10) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return { left: minX, top: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

async function main() {
  const srcImg = sharp(src).flatten({ background: '#ffffff' });
  const srcMeta = await srcImg.metadata();

  // Crop to the visible logo, then add a small breathing margin (6%) and pad
  // to a square so the logo fills the icon canvas edge-to-edge.
  const box = await contentBounds(sharp(src).ensureAlpha());
  const pad = Math.round(Math.max(box.width, box.height) * 0.06);
  const cropL = Math.max(0, box.left - pad);
  const cropT = Math.max(0, box.top - pad);
  const cropR = Math.min(srcMeta.width, box.left + box.width + pad);
  const cropB = Math.min(srcMeta.height, box.top + box.height + pad);
  const size = Math.max(cropR - cropL, cropB - cropT);

  const img = sharp(src)
    .extract({ left: cropL, top: cropT, width: cropR - cropL, height: cropB - cropT })
    .resize(size, size, { fit: 'fill' });

  // Electron window icon + installer icon source.
  const iconPng = path.join(root, 'electron', 'build-assets', 'icon.png');
  await img.clone().png().toFile(iconPng);
  console.log('Wrote', iconPng);

  // Multi-resolution Windows .ico (16, 24, 32, 48, 64, 128, 256).
  const icoPath = path.join(root, 'electron', 'build-assets', 'icon.ico');
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const buffers = [];
  for (const s of sizes) {
    buffers.push(await img.clone().resize(s, s).png().toBuffer());
  }
  const ico = await pngToIco(buffers);
  require('fs').writeFileSync(icoPath, ico);
  console.log('Wrote', icoPath, `(${sizes.length} sizes)`);

  // Mobile PWA icons.
  const pwaDir = path.join(root, 'public', 'icons');
  for (const s of [192, 512]) {
    const p = path.join(pwaDir, `icon-${s}.png`);
    await img.clone().resize(s, s).png().toFile(p);
    console.log('Wrote', p);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
