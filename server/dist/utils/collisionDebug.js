"use strict";
/**
 * Collision Debug Utility
 * Helps visualize and debug collision detection issues
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.visualizeMask = visualizeMask;
exports.testCollisionPoint = testCollisionPoint;
exports.debugCollision = debugCollision;
function visualizeMask(mask, size, label = 'Mask') {
    console.log(`\n=== ${label} (${size}x${size}) ===`);
    // Count opaque pixels
    let opaqueCount = 0;
    for (let i = 0; i < size * size; i++) {
        if (mask[i] !== 0)
            opaqueCount++;
    }
    console.log(`Opaque pixels: ${opaqueCount} / ${size * size} (${(opaqueCount / (size * size) * 100).toFixed(2)}%)`);
    // Find bounding box
    let minX = size, maxX = -1, minY = size, maxY = -1;
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            if (mask[y * size + x] !== 0) {
                if (x < minX)
                    minX = x;
                if (x > maxX)
                    maxX = x;
                if (y < minY)
                    minY = y;
                if (y > maxY)
                    maxY = y;
            }
        }
    }
    if (maxX >= 0) {
        console.log(`Bounding box: (${minX}, ${minY}) to (${maxX}, ${maxY})`);
        console.log(`Size: ${maxX - minX + 1}x${maxY - minY + 1}`);
        console.log(`Center: (${Math.round((minX + maxX) / 2)}, ${Math.round((minY + maxY) / 2)})`);
    }
    else {
        console.log('No opaque pixels found!');
    }
    // ASCII visualization (sample every Nth pixel)
    const sampleRate = Math.max(1, Math.floor(size / 64));
    console.log(`\nVisualization (sampling every ${sampleRate} pixels):`);
    for (let y = 0; y < size; y += sampleRate) {
        let line = '';
        for (let x = 0; x < size; x += sampleRate) {
            line += mask[y * size + x] !== 0 ? '█' : '·';
        }
        console.log(line);
    }
}
function testCollisionPoint(mask, maskSize, worldX, worldY, sharkX, sharkY, sharkAngle, sharkScale, renderSize) {
    // This mirrors the collision detection logic from the server
    const SHARK_SCALE = renderSize / maskSize; // Base scale (e.g., 171/256 = 2/3)
    // Calculate shark center in world space
    const sharkCenterX = sharkX + (renderSize * sharkScale) / 2;
    const sharkCenterY = sharkY + (renderSize * sharkScale) / 2;
    // Get world delta from shark center to test point
    const dx = worldX - sharkCenterX;
    const dy = worldY - sharkCenterY;
    // Shark rotation (server adds +180° to match sprite orientation)
    const rot = sharkAngle + Math.PI;
    // Determine if shark is horizontally flipped
    let deg = (sharkAngle * 180 / Math.PI) % 360;
    if (deg < 0)
        deg += 360;
    const flipY = (deg > 270 || deg < 90) ? -1 : 1;
    // Inverse rotation to get shark-local coordinates
    const cos = Math.cos(-rot);
    const sin = Math.sin(-rot);
    const rx = cos * dx - sin * dy;
    const ry = sin * dx + cos * dy;
    // Apply flip
    const lx = rx;
    const ly = ry * flipY;
    // Scale to mask space
    const scale = SHARK_SCALE * sharkScale;
    const maskX = Math.round((lx / scale) + maskSize / 2);
    const maskY = Math.round((ly / scale) + maskSize / 2);
    // Check bounds
    if (maskX < 0 || maskX >= maskSize || maskY < 0 || maskY >= maskSize) {
        return false;
    }
    // Check mask
    return mask[maskY * maskSize + maskX] !== 0;
}
function debugCollision(mask, maskSize, sharkX, sharkY, sharkAngle, sharkScale, renderSize, testPoints) {
    console.log('\n=== Collision Debug ===');
    console.log(`Shark position: (${sharkX.toFixed(1)}, ${sharkY.toFixed(1)})`);
    console.log(`Shark angle: ${(sharkAngle * 180 / Math.PI).toFixed(1)}°`);
    console.log(`Shark scale: ${sharkScale.toFixed(3)}x`);
    console.log(`Render size: ${renderSize}px`);
    console.log(`Mask size: ${maskSize}px`);
    const SHARK_SCALE = renderSize / maskSize;
    const sharkCenterX = sharkX + (renderSize * sharkScale) / 2;
    const sharkCenterY = sharkY + (renderSize * sharkScale) / 2;
    console.log(`Shark center: (${sharkCenterX.toFixed(1)}, ${sharkCenterY.toFixed(1)})`);
    console.log(`Base scale factor: ${SHARK_SCALE.toFixed(3)}`);
    console.log('\nTest points:');
    for (const point of testPoints) {
        const hit = testCollisionPoint(mask, maskSize, point.x, point.y, sharkX, sharkY, sharkAngle, sharkScale, renderSize);
        console.log(`  ${point.label} (${point.x}, ${point.y}): ${hit ? 'HIT ✓' : 'MISS ✗'}`);
    }
}
