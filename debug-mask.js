const sharp = require('sharp');
const fs = require('fs');

async function debugMask() {
  const pngPath = 'server/sharks/Baby Shark.png';
  const size = 256;
  const alphaThreshold = 128;

  console.log('Loading PNG:', pngPath);
  
  // Load the PNG and extract raw pixel data with alpha channel
  const { data, info } = await sharp(pngPath)
    .resize(size, size, {
      fit: 'fill',
      kernel: 'nearest'
    })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  console.log('Image info:', info);
  console.log('Data length:', data.length);
  console.log('Expected length:', size * size * info.channels);

  // Create binary mask array
  const mask = new Uint8Array(size * size);
  const channels = info.channels;

  // Extract alpha channel and convert to binary mask
  let opaqueCount = 0;
  let transparentCount = 0;
  
  for (let i = 0; i < size * size; i++) {
    const alphaIndex = i * channels + 3;
    const alpha = data[alphaIndex];
    mask[i] = alpha > alphaThreshold ? 1 : 0;
    if (mask[i] === 1) opaqueCount++;
    else transparentCount++;
  }

  console.log('\nMask statistics:');
  console.log('Opaque pixels (1):', opaqueCount);
  console.log('Transparent pixels (0):', transparentCount);
  console.log('Opaque percentage:', (opaqueCount / (size * size) * 100).toFixed(2) + '%');

  // Find bounding box of opaque pixels
  let minX = size, maxX = -1, minY = size, maxY = -1;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (mask[y * size + x] === 1) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  console.log('\nBounding box of opaque pixels:');
  console.log('X range:', minX, '-', maxX, '(width:', maxX - minX + 1, ')');
  console.log('Y range:', minY, '-', maxY, '(height:', maxY - minY + 1, ')');
  console.log('Center of bounding box:', Math.round((minX + maxX) / 2), Math.round((minY + maxY) / 2));

  // Create a visual representation (ASCII art)
  console.log('\nVisual representation (every 8th pixel):');
  for (let y = 0; y < size; y += 8) {
    let line = '';
    for (let x = 0; x < size; x += 8) {
      line += mask[y * size + x] === 1 ? '█' : '·';
    }
    console.log(line);
  }

  // Save mask as a PNG for visual inspection
  const maskImageData = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    const val = mask[i] === 1 ? 255 : 0;
    maskImageData[i * 4] = val;     // R
    maskImageData[i * 4 + 1] = val; // G
    maskImageData[i * 4 + 2] = val; // B
    maskImageData[i * 4 + 3] = 255; // A
  }

  await sharp(maskImageData, {
    raw: {
      width: size,
      height: size,
      channels: 4
    }
  })
  .png()
  .toFile('debug-mask-output.png');

  console.log('\n✓ Saved mask visualization to debug-mask-output.png');
}

debugMask().catch(console.error);

