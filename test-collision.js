const sharp = require('sharp');

async function testCollision() {
  const pngPath = 'server/sharks/Baby Shark.png';
  const size = 256;
  const alphaThreshold = 128;

  // Generate mask
  const { data, info } = await sharp(pngPath)
    .resize(size, size, {
      fit: 'fill',
      kernel: 'nearest'
    })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const mask = new Uint8Array(size * size);
  const channels = info.channels;

  for (let i = 0; i < size * size; i++) {
    const alphaIndex = i * channels + 3;
    const alpha = data[alphaIndex];
    mask[i] = alpha > alphaThreshold ? 1 : 0;
  }

  // Test collision at center
  console.log('Testing collision at various points:');
  console.log('=====================================\n');

  // Center of image
  const centerX = 128, centerY = 128;
  console.log(`Center (${centerX}, ${centerY}):`, mask[centerY * size + centerX] === 1 ? 'HIT' : 'MISS');

  // Test points around the shark
  const testPoints = [
    { name: 'Top-left corner', x: 0, y: 0 },
    { name: 'Top-right corner', x: 255, y: 0 },
    { name: 'Bottom-left corner', x: 0, y: 255 },
    { name: 'Bottom-right corner', x: 255, y: 255 },
    { name: 'Left edge of shark', x: 50, y: 125 },
    { name: 'Right edge of shark', x: 200, y: 125 },
    { name: 'Top of shark', x: 128, y: 80 },
    { name: 'Bottom of shark', x: 128, y: 170 },
  ];

  for (const point of testPoints) {
    const hit = mask[point.y * size + point.x] === 1;
    console.log(`${point.name} (${point.x}, ${point.y}):`, hit ? 'HIT ✓' : 'MISS ✗');
  }

  // Find actual leftmost and rightmost points (for mouth/tail)
  let leftmost = { x: size, y: 0 };
  let rightmost = { x: -1, y: 0 };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (mask[y * size + x] === 1) {
        if (x < leftmost.x) {
          leftmost = { x, y };
        }
        break;
      }
    }
    for (let x = size - 1; x >= 0; x--) {
      if (mask[y * size + x] === 1) {
        if (x > rightmost.x) {
          rightmost = { x, y };
        }
        break;
      }
    }
  }

  console.log('\nMouth/Tail positions:');
  console.log('=====================');
  console.log('Leftmost point (mouth):', leftmost);
  console.log('Rightmost point (tail):', rightmost);
  console.log('Mouth offset from center:', { x: leftmost.x - 128, y: leftmost.y - 128 });
  console.log('Tail offset from center:', { x: rightmost.x - 128, y: rightmost.y - 128 });

  // Create a visualization showing the mask with coordinate grid
  console.log('\nMask visualization with coordinates (every 16 pixels):');
  console.log('====================================================');
  
  // Header
  let header = '    ';
  for (let x = 0; x < size; x += 16) {
    header += String(x).padStart(3, ' ') + ' ';
  }
  console.log(header);

  for (let y = 0; y < size; y += 4) {
    let line = String(y).padStart(3, ' ') + ' ';
    for (let x = 0; x < size; x += 4) {
      const hit = mask[y * size + x] === 1;
      line += hit ? '█' : '·';
    }
    console.log(line);
  }
}

testCollision().catch(console.error);

