/**
 * Mask Generation Utility
 * Generates binary collision masks from PNG alpha channels at runtime
 */

import sharp from 'sharp';
import * as path from 'path';

/**
 * Generate a binary mask from a PNG file's alpha channel
 * @param pngPath - Path to the PNG file
 * @param size - Size of the mask (width and height, assumes square image)
 * @param alphaThreshold - Alpha value threshold (0-255) to consider a pixel as solid
 * @returns Uint8Array where 1 = solid pixel, 0 = transparent pixel
 */
export async function generateMaskFromPNG(
  pngPath: string,
  size: number = 256,
  alphaThreshold: number = 200  // High threshold to only include fully opaque pixels (was 128)
): Promise<Uint8Array> {
  try {
    // Load the PNG and resize if needed
    // Extract raw pixel data with alpha channel
    let sharpInstance = sharp(pngPath);

    // Get metadata to check if resize is needed
    const metadata = await sharpInstance.metadata();

    // Only resize if dimensions don't match
    if (metadata.width !== size || metadata.height !== size) {
      sharpInstance = sharpInstance.resize(size, size, {
        fit: 'fill',
        kernel: 'nearest' // Preserve sharp edges
      });
    }

    const { data, info } = await sharpInstance
      .ensureAlpha() // Ensure alpha channel exists
      .raw()
      .toBuffer({ resolveWithObject: true });

    // Create binary mask array
    const mask = new Uint8Array(size * size);
    const channels = info.channels; // Should be 4 (RGBA)

    // Extract alpha channel and convert to binary mask
    // Use a low threshold to catch any visible pixels (including anti-aliased edges)
    for (let i = 0; i < size * size; i++) {
      const alphaIndex = i * channels + 3; // Alpha is the 4th channel
      const alpha = data[alphaIndex];
      mask[i] = alpha > alphaThreshold ? 1 : 0;
    }

    return mask;
  } catch (error) {
    console.error(`Failed to generate mask from ${pngPath}:`, error);
    throw error;
  }
}

/**
 * Compute the mouth anchor point from a binary mask
 * Mouth is defined as the leftmost opaque pixel (median Y position)
 * @param mask - Binary mask array
 * @param size - Size of the mask (width and height)
 * @returns {x, y} coordinates of the mouth anchor
 */
export function computeMouthAnchorFromMask(
  mask: Uint8Array,
  size: number
): { x: number; y: number } {
  const rows: number[] = [];
  let minX = size;

  // Find leftmost opaque pixel
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (mask[y * size + x] !== 0) {
        if (x < minX) {
          minX = x;
          rows.length = 0;
          rows.push(y);
        } else if (x === minX) {
          rows.push(y);
        }
        break; // Move to next row after finding first opaque pixel
      }
    }
  }

  // Use median Y position
  const yMed = rows.length ? rows[Math.floor(rows.length / 2)] : Math.round(size / 2);
  return { x: minX, y: yMed };
}

/**
 * Compute the tail anchor point from a binary mask
 * Tail is defined as the rightmost opaque pixel (median Y position)
 * @param mask - Binary mask array
 * @param size - Size of the mask (width and height)
 * @returns {x, y} coordinates of the tail anchor
 */
export function computeTailAnchorFromMask(
  mask: Uint8Array,
  size: number
): { x: number; y: number } {
  const rows: number[] = [];
  let maxX = -1;

  // Find rightmost opaque pixel
  for (let y = 0; y < size; y++) {
    for (let x = size - 1; x >= 0; x--) {
      if (mask[y * size + x] !== 0) {
        if (x > maxX) {
          maxX = x;
          rows.length = 0;
          rows.push(y);
        } else if (x === maxX) {
          rows.push(y);
        }
        break; // Move to next row after finding first opaque pixel from right
      }
    }
  }

  // Use median Y position
  const yMed = rows.length ? rows[Math.floor(rows.length / 2)] : Math.round(size / 2);
  return { x: maxX, y: yMed };
}

/**
 * Load all shark masks from PNG files
 * @param sharkFiles - Array of shark filenames (e.g., ['Baby Shark.png', 'Great White Shark.png'])
 * @param sharksDir - Directory containing shark PNG files
 * @param maskSize - Size of the masks to generate
 * @returns Map of shark filename to mask data
 */
export async function loadAllSharkMasks(
  sharkFiles: string[],
  sharksDir: string,
  maskSize: number = 256
): Promise<Map<string, Uint8Array>> {
  const masks = new Map<string, Uint8Array>();

  for (const sharkFile of sharkFiles) {
    try {
      const pngPath = path.join(sharksDir, sharkFile);
      const mask = await generateMaskFromPNG(pngPath, maskSize);
      masks.set(sharkFile, mask);
      console.log(`✓ Generated mask for ${sharkFile}`);
    } catch (error) {
      console.error(`✗ Failed to generate mask for ${sharkFile}:`, error);
      // Continue with other sharks even if one fails
    }
  }

  return masks;
}

/**
 * Generate mouth and tail offsets for all sharks
 * @param masks - Map of shark filename to mask data
 * @param maskSize - Size of the masks
 * @returns Object containing mouth and tail offset maps
 */
export function computeAllAnchors(
  masks: Map<string, Uint8Array>,
  maskSize: number = 256
): {
  mouthOffsets: Map<string, { x: number; y: number }>;
  tailOffsets: Map<string, { x: number; y: number }>;
} {
  const mouthOffsets = new Map<string, { x: number; y: number }>();
  const tailOffsets = new Map<string, { x: number; y: number }>();
  const center = maskSize / 2;

  for (const [sharkFile, mask] of masks.entries()) {
    try {
      // Compute mouth and tail positions
      const mouth = computeMouthAnchorFromMask(mask, maskSize);
      const tail = computeTailAnchorFromMask(mask, maskSize);

      // Store as offsets from center
      mouthOffsets.set(sharkFile, {
        x: mouth.x - center,
        y: mouth.y - center
      });

      tailOffsets.set(sharkFile, {
        x: tail.x - center,
        y: tail.y - center
      });

      console.log(`✓ Computed anchors for ${sharkFile}: mouth(${mouth.x}, ${mouth.y}), tail(${tail.x}, ${tail.y})`);
    } catch (error) {
      console.error(`✗ Failed to compute anchors for ${sharkFile}:`, error);
    }
  }

  return { mouthOffsets, tailOffsets };
}

