import { Server } from 'socket.io';
import { createServer, IncomingMessage, ServerResponse } from 'http';
import { promises as fsp } from 'fs';
import * as path from 'path';
import { extname, join, normalize } from 'path';
import { createReadStream, existsSync, statSync } from 'fs';
import {
  generateMaskFromPNG,
  computeMouthAnchorFromMask,
  computeTailAnchorFromMask
} from './utils/maskGenerator';

interface Player {
    id: string;
    x: number;
    y: number;
    angle: number;
    username: string;
    score: number;
    hp: number;      // health points (0-100)
    dead: boolean;   // death state
    level: number;   // current level (1-100+)
    sharkType: string; // current shark sprite filename (e.g., "baby shark.png")
    // Abilities state
    abilities?: {
        quickDash?: { cooldownUntil: number; activeUntil: number };
        bubbleShield?: { cooldownUntil: number; activeUntil: number };
    };
}

interface Food { id: number; x: number; y: number; vx?: number; vy?: number; sx?: number; sy?: number; sid?: number; }

interface GameState {
    players: { [key: string]: Player };
    foods: { [key: number]: Food };
}

// Map configuration
const MAP_SIZE = 4000;
const PLAYER_RADIUS = Math.round(128 * (2/3)); // matches client baby shark size (2/3 of 256px = ~171px)
// Collision mask configuration
const SHARK_MASK_SIZE = 256; // Original mask size (masks are still 256x256)
const SHARK_SIZE = Math.round(256 * (2/3)); // baby shark sprite size (2/3 of original = ~171px)
const SHARK_HALF = SHARK_SIZE / 2;
const SHARK_SCALE = SHARK_SIZE / SHARK_MASK_SIZE; // Scale factor (2/3)
const FOOD_SIZE = Math.round(50 * 0.75); // must match client FISHFOOD_SIZE (~38)
const FOOD_HALF = Math.floor(FOOD_SIZE / 2);


// Visual scale per shark type (Baby -> Megalodon)
// Linear scaling: Baby Shark (index 0) = 1.0x, Megalodon (index 19) = 2.0x
let SHARK_EVOLUTIONS: string[] = [];

function getSharkScaleForType(type: string | undefined): number {
  if (!type || !SHARK_EVOLUTIONS || SHARK_EVOLUTIONS.length === 0) return 1.0;
  const idx = SHARK_EVOLUTIONS.indexOf(type);
  if (idx < 0) return 1.0;

  // Total number of shark types (20 sharks: index 0-19)
  const totalSharks = SHARK_EVOLUTIONS.length;
  if (totalSharks <= 1) return 1.0;

  // Linear interpolation: 1.0 + (idx / (totalSharks - 1)) * (2.0 - 1.0)
  // Baby Shark (idx=0): 1.0 + (0/19) * 1.0 = 1.0
  // Megalodon (idx=19): 1.0 + (19/19) * 1.0 = 2.0
  const scale = 1.0 + (idx / (totalSharks - 1)) * 1.0;
  return Math.min(2.0, Math.max(1.0, scale));
}

async function loadSharkEvolutions(): Promise<void> {
  try {
    const p = path.join('server', 'sharks', 'sharkevolutionranking.json');
    const txt = await fsp.readFile(p, 'utf8');
    const data = JSON.parse(txt);
    const evolutions: string[] = [];
    for (let i = 1; i <= 20; i++) {
      const key = `shark${i}`;
      if (data[key]) {
        const innerKey = Object.keys(data[key])[0];
        evolutions.push(data[key][innerKey]);
      }
    }
    SHARK_EVOLUTIONS = evolutions;
    console.log(`Loaded ${SHARK_EVOLUTIONS.length} shark evolutions`);
  } catch (e) {
    console.error('Failed to load shark evolutions', e);
    SHARK_EVOLUTIONS = ['Baby Shark.png']; // fallback
  }
}

// Compute level from score using LEVEL_STEPS
function computeLevel(score: number): number {
  if (!LEVEL_STEPS || LEVEL_STEPS.length === 0) return 1;
  let lvl = 1;
  let remaining = Math.max(0, score | 0);
  for (let i = 0; i < LEVEL_STEPS.length; i++) {
    const need = LEVEL_STEPS[i] | 0;
    if (remaining >= need) {
      remaining -= need;
      lvl++;
    } else {
      break;
    }
  }
  return Math.min(100, lvl); // cap at level 100
}

// Get shark type from level (every 5 levels, capped at megalodon for 100+)
function getSharkTypeForLevel(level: number): string {
  if (!SHARK_EVOLUTIONS || SHARK_EVOLUTIONS.length === 0) return 'Baby Shark.png';
  // Level 1-4: shark 1 (baby shark) - index 0
  // Level 5-9: shark 2 (zebra shark) - index 1
  // Level 10-14: shark 3 (nurse shark) - index 2
  // ...
  // Level 100+: shark 20 (megalodon) - index 19
  const index = Math.min(19, Math.floor(level / 5));
  return SHARK_EVOLUTIONS[index] || 'Baby Shark.png';
}

// Format shark name for display (e.g., "Baby Shark.png" -> "Baby Shark")
function formatSharkName(sharkType: string): string {
  return sharkType.replace('.png', '');
}


// Movement + server-authority helpers
const SELF_SPEED = 495; // px/s (1.5x boost), server authoritative
const SPEED_TOL = 1.25; // tolerance for jitter/latency


type BubbleSeed = { left: number; delay: number };
const BUBBLE_SEEDS: BubbleSeed[] = Array.from({ length: 28 }, () => ({ left: Math.random() * 100, delay: -Math.random() * 14 }));

// Combat projectiles (server-authoritative bubbles)
type Bubble = {
  id: number;
  ownerId: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  expireAt: number; // epoch ms when bubble should despawn
};
const BUBBLE_SPEED = 900;        // px/s, fast and consistent
const BUBBLE_TTL_MS = 1000;      // lifespan 1.0 seconds (auto fade after removal on client)
const SHOOT_COOLDOWN_MS = 500;   // 0.5 seconds per player (reload)

// Mouth offset relative to shark center (rotate by angle + 180deg)
// Note: These are in mask space (256x256), will be scaled to render space when used
let MOUTH_OFFSET_X = 26 - (SHARK_MASK_SIZE / 2);  // fallback if mask not available
let MOUTH_OFFSET_Y = 150 - (SHARK_MASK_SIZE / 2);

// computeMouthAnchorFromMask and computeTailAnchorFromMask are now imported from maskGenerator.ts

// Active bubbles collection
const bubbles: { [id: number]: Bubble } = {};
let nextBubbleId = 1;
let projDirty = false; // whether projectiles changed (for emitting empty updates)

const lastUpdate = new Map<string, number>();
const lastPos = new Map<string, { x: number; y: number }>();


// Per-player shooting cooldown timestamps
const lastShotAt = new Map<string, number>();

// Per-player-pair collision damage cooldown (key: "id1:id2" sorted)
const lastCollisionDamageAt = new Map<string, number>();

// Keep last known username per socket (used to respawn after death removal)
const usernames = new Map<string, string>();

// Parsed alpha masks (1=opaque, 0=transparent)
let sharkMask: Uint8Array | null = null; // length SHARK_SIZE*SHARK_SIZE
let foodMask: Uint8Array | null = null;  // length FOOD_SIZE*FOOD_SIZE

// Combat bookkeeping for assists and kill awards
const ASSIST_WINDOW_MS = 20_000; // 20 seconds
const BULLET_DAMAGE = 5; // keep in sync with client HP logic
// victimId -> (attackerId -> { dmg, last })
const damageByVictim = new Map<string, Map<string, { dmg: number; last: number }>>();

// Level progression (XP to go from level L to L+1), zero-based index (0 => 1->2)
let LEVEL_STEPS: number[] = [];

// Shark evolution system - per-shark masks and offsets
const sharkMasks = new Map<string, Uint8Array>(); // Cache of loaded shark masks
const sharkMouthOffsets = new Map<string, { x: number; y: number }>(); // Mouth positions per shark
const sharkTailOffsets = new Map<string, { x: number; y: number }>(); // Tail positions per shark

// Shark collision constants
const SHARK_COLLISION_DAMAGE = 10; // damage dealt when sharks collide
const SHARK_COLLISION_COOLDOWN_MS = 1000; // 1 second cooldown between collision damage

// Abilities configuration
interface AbilityConfig {
  name: string;
  description: string;
  durationSeconds: number;
  cooldownSeconds: number;
  activationKey: string;
}

interface AbilitiesData {
  abilities: {
    quickDash: AbilityConfig;
    bubbleShield: AbilityConfig;
  };
}

let abilitiesConfig: AbilitiesData | null = null;

// Load abilities configuration
async function loadAbilitiesConfig() {
  try {
    const data = await fsp.readFile(path.join('server', 'abilities', 'abilities.json'), 'utf-8');
    abilitiesConfig = JSON.parse(data);
    console.log('✓ Abilities configuration loaded');
  } catch (err) {
    console.error('Failed to load abilities config:', err);
  }
}

function parseBinaryMask(txt: string, w: number, h: number): Uint8Array {
  // Keep only 0/1 and newlines, flatten
  const flat = txt.replace(/[^01\n]/g, '').replace(/\n+/g, '');
  const arr = new Uint8Array(w * h);
  const n = Math.min(flat.length, w * h);
  for (let i = 0; i < n; i++) arr[i] = flat.charCodeAt(i) === 49 ? 1 : 0;
  return arr;
}

function resampleNearest(src: Uint8Array, srcW: number, srcH: number, dstW: number, dstH: number): Uint8Array {
  const dst = new Uint8Array(dstW * dstH);
  for (let y = 0; y < dstH; y++) {
    const sy = Math.floor((y + 0.5) * srcH / dstH);
    for (let x = 0; x < dstW; x++) {
      const sx = Math.floor((x + 0.5) * srcW / dstW);
      dst[y * dstW + x] = src[sy * srcW + sx];
    }
  }
  return dst;
}



// Load a specific shark's mask from PNG and compute mouth/tail positions
async function loadSharkMask(sharkFilename: string): Promise<void> {
  if (sharkMasks.has(sharkFilename)) return; // already loaded

  try {
    // Generate mask from PNG alpha channel
    const pngPath = path.join('server', 'sharks', sharkFilename);
    const mask = await generateMaskFromPNG(pngPath, SHARK_MASK_SIZE);
    sharkMasks.set(sharkFilename, mask);

    // Compute mouth and tail positions
    try {
      const mouth = computeMouthAnchorFromMask(mask, SHARK_MASK_SIZE);
      sharkMouthOffsets.set(sharkFilename, {
        x: mouth.x - (SHARK_MASK_SIZE / 2),
        y: mouth.y - (SHARK_MASK_SIZE / 2)
      });
    } catch (e) {
      console.warn(`Failed to compute mouth for ${sharkFilename}`, e);
      sharkMouthOffsets.set(sharkFilename, { x: MOUTH_OFFSET_X, y: MOUTH_OFFSET_Y });
    }

    try {
      const tail = computeTailAnchorFromMask(mask, SHARK_MASK_SIZE);
      sharkTailOffsets.set(sharkFilename, {
        x: tail.x - (SHARK_MASK_SIZE / 2),
        y: tail.y - (SHARK_MASK_SIZE / 2)
      });
    } catch (e) {
      console.warn(`Failed to compute tail for ${sharkFilename}`, e);
      // Default tail to opposite side of mouth
      const mouth = sharkMouthOffsets.get(sharkFilename) || { x: MOUTH_OFFSET_X, y: MOUTH_OFFSET_Y };
      sharkTailOffsets.set(sharkFilename, { x: -mouth.x, y: mouth.y });
    }

    console.log(`✓ Generated mask from PNG for ${sharkFilename}`);
  } catch (e) {
    console.error(`✗ Failed to generate mask for ${sharkFilename}`, e);
    // Use baby shark as fallback
    if (sharkMask) {
      sharkMasks.set(sharkFilename, sharkMask);
      sharkMouthOffsets.set(sharkFilename, { x: MOUTH_OFFSET_X, y: MOUTH_OFFSET_Y });
      const mouth = sharkMouthOffsets.get(sharkFilename) || { x: MOUTH_OFFSET_X, y: MOUTH_OFFSET_Y };
      sharkTailOffsets.set(sharkFilename, { x: -mouth.x, y: mouth.y });
    }
  }
}

// Get mask for a specific player's shark type
function getPlayerMask(player: Player): Uint8Array | null {
  if (!player.sharkType) return sharkMask;
  return sharkMasks.get(player.sharkType) || sharkMask;
}

// Preload all shark masks at startup for better performance (parity with game server)
async function preloadAllSharkMasks(): Promise<void> {
  if (!SHARK_EVOLUTIONS || SHARK_EVOLUTIONS.length === 0) {
    console.warn('No shark evolutions loaded, skipping mask preload');
    return;
  }
  console.log('Preloading all shark masks...');
  for (const sharkType of SHARK_EVOLUTIONS) {
    try {
      await loadSharkMask(sharkType);
    } catch (e) {
      console.error(`Failed to preload mask for ${sharkType}:`, e);
    }
  }
  console.log('All shark masks preloaded');
}

async function loadLevelProgression(): Promise<void> {
  try {
    const p = path.join('server', 'progression', 'levelprogression.txt');
    const txt = await fsp.readFile(p, 'utf8');
    const steps: number[] = [];
    for (const line of txt.split(/\r?\n/)) {
      const m = line.match(/->\s*\d+\s*=\s*([\d,]+)/);
      if (m) {
        const n = parseInt(m[1].replace(/,/g, ''), 10);
        if (!isNaN(n) && n > 0) steps.push(n);
      }
    }
    LEVEL_STEPS = steps;
    console.log(`Loaded ${LEVEL_STEPS.length} level steps`);
  } catch (e) {
    console.error('Failed to load level progression', e);
    LEVEL_STEPS = [];
  }
}

async function loadServerMasks(): Promise<void> {
  try {
    // Generate baby shark mask from PNG
    const babySharkPng = path.join('server', 'sharks', 'Baby Shark.png');
    const rawShark = await generateMaskFromPNG(babySharkPng, SHARK_MASK_SIZE);
    sharkMask = rawShark;
    try {
      const mouth = computeMouthAnchorFromMask(sharkMask, SHARK_MASK_SIZE);
      // Mouth is in mask space, keep it there (will scale when using)
      MOUTH_OFFSET_X = mouth.x - (SHARK_MASK_SIZE / 2);
      MOUTH_OFFSET_Y = mouth.y - (SHARK_MASK_SIZE / 2);
    } catch {}
    console.log('✓ Generated baby shark mask from PNG');
  } catch (e) {
    console.error('✗ Failed to generate shark mask from Baby Shark.png', e);
    sharkMask = null;
  }

  try {
    // Generate food mask from PNG
    const foodPng = path.join('server', 'food', 'FishFood.png');
    const rawFood = await generateMaskFromPNG(foodPng, 64);
    foodMask = resampleNearest(rawFood, 64, 64, FOOD_SIZE, FOOD_SIZE);
    console.log('✓ Generated food mask from PNG');
  } catch (e) {
    console.error('✗ Failed to generate food mask from FishFood.png', e);
    foodMask = null;
  }
}

function pixelPerfectOverlap(me: Player, food: Food): boolean {
  const playerMask = getPlayerMask(me);
  if (!playerMask || !foodMask) return false;
  // Coarse prune with per-shark scale
  const sf = getSharkScaleForType(me.sharkType);
  const effR = PLAYER_RADIUS * sf;
  const cx = me.x + effR, cy = me.y + effR;
  const dx = cx - food.x, dy = cy - food.y;
  const maxR = effR + FOOD_HALF + 20;
  if ((dx * dx + dy * dy) > (maxR * maxR)) return false;

  // Match client rendering: rotate(angle + PI) then scaleY(flipY)
  const a = me.angle;
  let deg = (a * 180 / Math.PI) % 360;
  if (deg < 0) deg += 360;
  const flipY = (deg > 270 || deg < 90) ? -1 : 1;

  const rot = a + Math.PI;
  const cosInv = Math.cos(-rot), sinInv = Math.sin(-rot);
  const scale = SHARK_SCALE * sf;

  // Iterate food pixels and check if they hit shark mask
  for (let fy = 0; fy < FOOD_SIZE; fy++) {
    for (let fx = 0; fx < FOOD_SIZE; fx++) {
      if (foodMask[fy * FOOD_SIZE + fx] === 0) continue;

      // Food pixel world position (center of pixel) — food.x/y are CENTER on client
      const wx = food.x - FOOD_HALF + fx + 0.5;
      const wy = food.y - FOOD_HALF + fy + 0.5;

      // Translate to shark-local space
      const vx = wx - cx;
      const vy = wy - cy;

      // Apply inverse rotation
      const rx = cosInv * vx - sinInv * vy;
      const ry = sinInv * vx + cosInv * vy;

      // Apply inverse flip
      const lx = rx;
      const ly = ry * flipY;

      // Convert to mask coordinates
      const mx = (lx / scale) + (SHARK_MASK_SIZE / 2);
      const my = (ly / scale) + (SHARK_MASK_SIZE / 2);

      // Check center pixel
      const mxi = Math.round(mx);
      const myi = Math.round(my);
      if (mxi >= 0 && myi >= 0 && mxi < SHARK_MASK_SIZE && myi < SHARK_MASK_SIZE) {
        if (playerMask[myi * SHARK_MASK_SIZE + mxi] !== 0) return true;
      }

      // Check 3x3 neighborhood for sub-pixel accuracy
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const tx = mxi + dx;
          const ty = myi + dy;
          if (tx >= 0 && ty >= 0 && tx < SHARK_MASK_SIZE && ty < SHARK_MASK_SIZE) {
            if (playerMask[ty * SHARK_MASK_SIZE + tx] !== 0) return true;
          }
        }
      }
    }
  }

  return false;
}

// Check if player leveled up and handle evolution
async function checkAndHandleEvolution(player: Player): Promise<void> {
  const oldLevel = player.level || 1;
  const newLevel = computeLevel(player.score);

  if (newLevel > oldLevel) {
    player.level = newLevel;
    const newSharkType = getSharkTypeForLevel(newLevel);

    // Check if shark type changed (evolution every 5 levels)
    if (newSharkType !== player.sharkType) {
      const oldSharkType = player.sharkType;
      player.sharkType = newSharkType;

      // Load the new shark's mask if not already loaded
      await loadSharkMask(newSharkType);

      console.log(`Player ${player.username} evolved from ${oldSharkType} to ${newSharkType} at level ${newLevel}`);

      // Get tail offset for client-side trail bubbles
      const tailOffset = sharkTailOffsets.get(newSharkType) || { x: -MOUTH_OFFSET_X, y: MOUTH_OFFSET_Y };

      // Emit smoke particle explosion effect to all clients (server-authoritative)
      io.emit('effect:smoke', {
        x: player.x,
        y: player.y,
        playerId: player.id,
        s: getSharkScaleForType(newSharkType)
      });

      // Emit evolution event to all clients
      io.emit('player:evolved', {
        id: player.id,
        username: player.username,
        level: newLevel,
        sharkType: newSharkType,
        x: player.x,
        y: player.y,
        tailOffset: tailOffset
      });
    }
  }
}

function handleConsume(me: Player, food: Food) {
  delete gameState.foods[food.id];
  const oldScore = me.score || 0;
  me.score = oldScore + 5;
  const newFood = spawnFoodDistributed();
  dirty = true;
  io.emit('food:respawn', { removedId: food.id, food: newFood });

  // Check for level-up/evolution
  checkAndHandleEvolution(me).catch(err => console.error('Evolution check failed:', err));
}

const FOOD_TARGET_COUNT = 125;
const FOOD_RADIUS = Math.round(50 * 0.75) / 2; // keep in sync with client FISHFOOD_SIZE/2 (~19px)

// ============================================
// STATIC FILE SERVING + API
// ============================================

const ROOTS = [
  join(process.cwd(), 'client'),
  join(process.cwd(), 'public'),
  join(process.cwd(), 'server'),
];

const USERS_FILE = join(process.cwd(), 'users', 'users.json');

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.txt': 'text/plain; charset=utf-8',
};

function tryResolve(pathname: string): string | null {
  const clean = pathname.replace(/\?.*$/, '').replace(/#.*$/, '');
  let decoded = clean;
  try { decoded = decodeURIComponent(clean); } catch {}
  const rel = decoded.startsWith('/') ? decoded.slice(1) : decoded;
  const safeRel = normalize(rel).replace(/^\.\/+/, '');

  const roots = safeRel.startsWith('sharks/') ? [ROOTS[2], ROOTS[0], ROOTS[1]] : ROOTS;
  for (const root of roots) {
    const full = join(root, safeRel);
    if (existsSync(full) && statSync(full).isFile()) return full;
    if (existsSync(full) && statSync(full).isDirectory()) {
      const idx = join(full, 'index.html');
      if (existsSync(idx)) return idx;
    }
  }
  const fallback = join(ROOTS[0], 'index.html');
  return existsSync(fallback) ? fallback : null;
}

async function readBody(req: IncomingMessage): Promise<string> {
  return await new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk: Buffer) => (data += chunk.toString('utf8')));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

async function getUsers(): Promise<any[]> {
  try {
    const buf = await fsp.readFile(USERS_FILE, 'utf8');
    const arr = JSON.parse(buf);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

async function saveUsers(users: any[]): Promise<void> {
  const dir = join(process.cwd(), 'users');
  try { await fsp.mkdir(dir, { recursive: true }); } catch {}
  await fsp.writeFile(USERS_FILE, JSON.stringify(users, null, 2));
}

// ============================================
// HTTP SERVER (Static Files + API + Socket.IO)
// ============================================

// Create HTTP server WITHOUT a request handler first
// Socket.IO will attach to it, then we'll add our handler
const httpServer = createServer();

// Add request handler for static files and API
httpServer.on('request', async (req: IncomingMessage, res: ServerResponse) => {
  const url = req.url || '/';
  const method = (req.method || 'GET').toUpperCase();

  // Skip Socket.IO routes - Socket.IO already handles them (match both with and without trailing slash)
  if (url.startsWith('/socket.io')) {
    return; // Already handled by Socket.IO
  }

  // API routes
  if (url.startsWith('/api/users')) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }

    try {
      if (method === 'GET' && url === '/api/users') {
        const users = await getUsers();
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify(users));
        return;
      }

      if (method === 'POST' && url === '/api/users') {
        const raw = await readBody(req);
        const body = raw ? JSON.parse(raw) : {};
        const { username, password, timeCreated } = body || {};
        if (!username || !password) { res.statusCode = 400; res.end('Missing fields'); return; }

        // Validate username length (max 16 characters for account usernames)
        const sanitizedUsername = String(username).trim().slice(0, 16);
        if (sanitizedUsername.length === 0) { res.statusCode = 400; res.end('Invalid username'); return; }

        const users = await getUsers();
        if (users.find((u) => u.username === sanitizedUsername)) { res.statusCode = 409; res.end('User exists'); return; }
        const user = { username: sanitizedUsername, password: String(password), timeCreated: timeCreated || new Date().toISOString() };
        users.push(user);
        await saveUsers(users);
        res.statusCode = 201;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ username: user.username, timeCreated: user.timeCreated }));
        return;
      }

      if (method === 'PATCH' && /^\/api\/users\//.test(url)) {
        const target = decodeURIComponent(url.split('/').pop() || '');
        const raw = await readBody(req);
        const body = raw ? JSON.parse(raw) : {};
        const { password } = body || {};
        if (!target || !password) { res.statusCode = 400; res.end('Missing fields'); return; }
        const users = await getUsers();
        const idx = users.findIndex((u) => u.username === target);
        if (idx === -1) { res.statusCode = 404; res.end('Not found'); return; }
        users[idx].password = String(password);
        await saveUsers(users);
        res.statusCode = 200;
        res.end('OK');
        return;
      }

      res.statusCode = 404; res.end('Not found'); return;
    } catch (err) {
      console.error('API error', err);
      res.statusCode = 500; res.end('Server error'); return;
    }
  }

  // Static file serving
  const file = tryResolve(url);
  if (!file) {
    res.statusCode = 404;
    res.end('Not found');
    return;
  }
  const type = TYPES[extname(file).toLowerCase()] || 'application/octet-stream';
  res.setHeader('Content-Type', type);
  createReadStream(file).pipe(res);
});

// Dynamic CORS configuration for development and production
const allowedOrigins = process.env.NODE_ENV === 'production'
    ? (process.env.FRONTEND_URL ? [process.env.FRONTEND_URL] : [])
    : [
        "http://localhost:3000",
        "http://localhost:3001",
        "http://127.0.0.1:3000",
        "http://127.0.0.1:3001"
      ];

console.log('CORS allowed origins:', allowedOrigins);

const io = new Server(httpServer, {
    cors: {
        origin: allowedOrigins,
        methods: ["GET", "POST"],
        credentials: true
    },
    transports: ['websocket', 'polling'],
    allowEIO3: true,
    pingTimeout: 60000,
    pingInterval: 25000,
    upgradeTimeout: 30000,
    maxHttpBufferSize: 1e6,
    allowUpgrades: true,
    perMessageDeflate: false,
    httpCompression: false,
    // Ensure proper connection handling
    connectTimeout: 45000,
    // Path for Socket.IO (explicit)
    path: '/socket.io',
    // Server-side options
    serveClient: false,
    // Connection state recovery (helps with reconnections)
    connectionStateRecovery: {
        maxDisconnectionDuration: 2 * 60 * 1000, // 2 minutes
        skipMiddlewares: true,
    }
});

const gameState: GameState = {
    players: {},
    foods: {}
};
let nextFoodId = 1;

// --- Fish schooling configuration ---
const SCHOOL_COUNT = 14; // number of schools across the map (slightly more to reduce empty space)
const SCHOOL_RADIUS = 540; // larger radius so schools cover more area (less empty space)
const SCHOOL_MARGIN = 200; // keep schools away from borders

type FoodSchool = { x: number; y: number; r: number };
const FOOD_SCHOOLS: FoodSchool[] = [];

let perSchoolTarget: number[] = [];

function nearestSchoolId(x: number, y: number): number {
  let bestI = 0; let bestD2 = Infinity;
  for (let i = 0; i < FOOD_SCHOOLS.length; i++) {
    const s = FOOD_SCHOOLS[i]; const dx = x - s.x, dy = y - s.y; const d2 = dx*dx + dy*dy;
    if (d2 < bestD2) { bestD2 = d2; bestI = i; }
  }
  return bestI;
}

function countFoodsPerSchool(): number[] {
  const counts = new Array(Math.max(FOOD_SCHOOLS.length, SCHOOL_COUNT)).fill(0);
  for (const f of Object.values(gameState.foods)) {
    if (typeof (f as Food).sid === 'number') counts[(f as Food).sid as number]++;
    else counts[nearestSchoolId((f as Food).x, (f as Food).y)]++;
  }
  return counts;
}

function recomputeSchoolTargets() {
  perSchoolTarget = new Array(FOOD_SCHOOLS.length).fill(8); // baseline 8 per school
  const desiredTotal = FOOD_TARGET_COUNT;
  let rem = Math.max(0, desiredTotal - (8 * FOOD_SCHOOLS.length));
  // randomly choose 'rem' schools to have 9 instead of 8
  const order: number[] = [];
  for (let i = 0; i < FOOD_SCHOOLS.length; i++) order.push(i);
  for (let i = order.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; [order[i], order[j]] = [order[j], order[i]]; }
  for (let i = 0; i < order.length && rem > 0; i++, rem--) perSchoolTarget[order[i]] = 9;
}

function initFoodSchools() {
  FOOD_SCHOOLS.length = 0;
  const minSep = SCHOOL_RADIUS * 1.5;
  let attempts = 0;
  while (FOOD_SCHOOLS.length < SCHOOL_COUNT && attempts < SCHOOL_COUNT * 200) {
    attempts++;
    const x = rand(SCHOOL_MARGIN, MAP_SIZE - SCHOOL_MARGIN);
    const y = rand(SCHOOL_MARGIN, MAP_SIZE - SCHOOL_MARGIN);
    let ok = true;
    for (const s of FOOD_SCHOOLS) {
      const dx = x - s.x, dy = y - s.y;
      if ((dx*dx + dy*dy) < (minSep * minSep)) { ok = false; break; }
    }
    if (ok) FOOD_SCHOOLS.push({ x, y, r: SCHOOL_RADIUS });
  }
  if (FOOD_SCHOOLS.length === 0) {
    FOOD_SCHOOLS.push({ x: MAP_SIZE/2, y: MAP_SIZE/2, r: SCHOOL_RADIUS });
  }
  recomputeSchoolTargets();
}

function pickFoodSchool(): FoodSchool {
  const counts = countFoodsPerSchool();
  const candidates: number[] = [];
  for (let i = 0; i < FOOD_SCHOOLS.length; i++) {
    if (i < perSchoolTarget.length && counts[i] < perSchoolTarget[i]) candidates.push(i);
  }
  let idx: number;
  if (candidates.length) {
    idx = candidates[(Math.random() * candidates.length) | 0];
  } else {
    // fallback: pick the least populated
    let min = Infinity; idx = 0;
    for (let i = 0; i < counts.length; i++) { if (counts[i] < min) { min = counts[i]; idx = i; } }
  }
  return FOOD_SCHOOLS[idx];
}

function rand(min: number, max: number) { return Math.random() * (max - min) + min; }

function nearestDistSq(x: number, y: number): number {
    let best = Infinity;
    // Distance to other foods (prefer far)
    for (const f of Object.values(gameState.foods)) {
        const dx = x - f.x, dy = y - f.y; const d2 = dx*dx + dy*dy; if (d2 < best) best = d2;
    }
    // Also stay away from players a bit for fairness
    for (const p of Object.values(gameState.players)) {
        const px = p.x + PLAYER_RADIUS, py = p.y + PLAYER_RADIUS;
        const dx = x - px, dy = y - py; const d2 = dx*dx + dy*dy; if (d2 < best) best = d2;
    }
    return best;
}

function spawnFoodDistributed(tries = 20): Food {
    // Cluster foods inside precomputed school regions to create pockets of emptiness elsewhere
    const m = FOOD_HALF + 20; // safe margin from edges
    const school = FOOD_SCHOOLS.length ? pickFoodSchool() : { x: MAP_SIZE/2, y: MAP_SIZE/2, r: Math.min(MAP_SIZE/2, SCHOOL_RADIUS) } as FoodSchool;
    const sid = nearestSchoolId(school.x, school.y);
    let best: { x: number; y: number; score: number } | null = null;
    for (let i = 0; i < tries; i++) {
        const ang = Math.random() * Math.PI * 2;
        const rad = school.r * Math.pow(Math.random(), 1.25); // slightly flatter density curve
        let cx = school.x + Math.cos(ang) * rad;
        let cy = school.y + Math.sin(ang) * rad;
        // keep within map bounds
        cx = Math.max(m, Math.min(MAP_SIZE - m, cx));
        cy = Math.max(m, Math.min(MAP_SIZE - m, cy));
        const score = nearestDistSq(cx, cy);
        if (!best || score > best.score) best = { x: cx, y: cy, score };
    }
    const ang = Math.random() * Math.PI * 2;
    const speed = rand(8, 18); // px/s, gentle drift
    const food: Food = { id: nextFoodId++, x: best!.x, y: best!.y, vx: Math.cos(ang) * speed, vy: Math.sin(ang) * speed, sx: school.x, sy: school.y, sid };
    gameState.foods[food.id] = food;
    return food;
}

function spawnFoodRandom(): Food {
  const m = FOOD_HALF + 20;
  const cx = rand(m, MAP_SIZE - m);
  const cy = rand(m, MAP_SIZE - m);
  const ang = Math.random() * Math.PI * 2;
  const sp = rand(8, 18);
  const food: Food = { id: nextFoodId++, x: cx, y: cy, vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp };
  gameState.foods[food.id] = food;
  return food;
}


function bubbleHitsShark(p: Player, bx: number, by: number): boolean {
  const playerMask = getPlayerMask(p);
  if (!playerMask) return false;
  // Coarse prune by radius to avoid heavy math when far (respect per-shark scale)
  const sf = getSharkScaleForType(p.sharkType);
  const cx = p.x + PLAYER_RADIUS * sf, cy = p.y + PLAYER_RADIUS * sf;
  const dx = bx - cx, dy = by - cy;
  const maxR = PLAYER_RADIUS * sf + 8; // increased slack for better edge detection
  if ((dx * dx + dy * dy) > (maxR * maxR)) return false;

  // Inverse of the visual transform applied on client: rotate(a+PI) then flipY based on quadrant
  const a = p.angle;
  let deg = (a * 180 / Math.PI) % 360; if (deg < 0) deg += 360;
  const flipY = (deg > 270 || deg < 90) ? -1 : 1; // client uses scaleY(-1) on right-facing quadrants
  const rot = a + Math.PI;
  const c = Math.cos(-rot), s = Math.sin(-rot);
  // Rotate world delta into shark-local, then apply flipY
  const rx = c * dx - s * dy;
  const ry = s * dx + c * dy;
  const lx = rx;
  const ly = ry * flipY;
  // Map to mask pixel coordinates (scale to mask space with visual scale sf)
  const scale = SHARK_SCALE * sf;
  const ux = Math.round((lx / scale) + (SHARK_MASK_SIZE / 2));
  const uy = Math.round((ly / scale) + (SHARK_MASK_SIZE / 2));
  if (ux < 0 || uy < 0 || ux >= SHARK_MASK_SIZE || uy >= SHARK_MASK_SIZE) return false;
  const idx = uy * SHARK_MASK_SIZE + ux;
  if (playerMask[idx] !== 0) return true;

  // Enhanced 7x7 kernel for better collision detection with scaled sprites and moving bullets
  // This ensures we catch bullets that hit any colored pixel of the shark
  for (let oy = -3; oy <= 3; oy++) {
    for (let ox = -3; ox <= 3; ox++) {
      const x = ux + ox, y = uy + oy;
      if (x < 0 || y < 0 || x >= SHARK_MASK_SIZE || y >= SHARK_MASK_SIZE) continue;
      if (playerMask[y * SHARK_MASK_SIZE + x] !== 0) return true;
    }
  }

  // Additional sub-pixel sampling for fast-moving bullets
  // Sample 4 points around the bullet center for better accuracy
  const offsets = [
    { dx: -1, dy: -1 }, { dx: 1, dy: -1 },
    { dx: -1, dy: 1 }, { dx: 1, dy: 1 }
  ];

  for (const offset of offsets) {
    const sx = ux + offset.dx;
    const sy = uy + offset.dy;
    if (sx < 0 || sy < 0 || sx >= SHARK_MASK_SIZE || sy >= SHARK_MASK_SIZE) continue;
    if (playerMask[sy * SHARK_MASK_SIZE + sx] !== 0) return true;
  }

  return false;
}

// Pixel-perfect bullet-to-fish collision detection
function bubbleHitsFish(food: Food, bx: number, by: number): boolean {
  if (!foodMask) return false;

  // Coarse prune by radius (food.x, food.y are center coordinates)
  const dx = bx - food.x;
  const dy = by - food.y;
  const maxR = FOOD_HALF + 8; // slack for better edge detection
  if ((dx * dx + dy * dy) > (maxR * maxR)) return false;

  // Fish don't rotate, so just check if bullet position hits food mask
  // Transform bullet to food-local coordinates (food center is at food.x, food.y)
  // Food mask top-left is at (food.x - FOOD_HALF, food.y - FOOD_HALF)
  const localX = bx - (food.x - FOOD_HALF);
  const localY = by - (food.y - FOOD_HALF);

  // Sample a 3x3 grid around the bullet position for better accuracy
  const sampleRadius = 1.5; // pixels
  for (let sy = -1; sy <= 1; sy++) {
    for (let sx = -1; sx <= 1; sx++) {
      const sampleX = localX + (sx * sampleRadius);
      const sampleY = localY + (sy * sampleRadius);

      const mx = Math.floor(sampleX);
      const my = Math.floor(sampleY);

      if (mx >= 0 && my >= 0 && mx < FOOD_SIZE && my < FOOD_SIZE) {
        if (foodMask[my * FOOD_SIZE + mx] !== 0) return true;
      }
    }
  }

  return false;
}

// Pixel-perfect shark-to-shark collision detection (scaled, robust for large sharks)
function sharkCollidesWithShark(shark1: Player, shark2: Player): boolean {
  const mask1 = getPlayerMask(shark1);
  const mask2 = getPlayerMask(shark2);
  if (!mask1 || !mask2) return false;

  const sf1 = getSharkScaleForType(shark1.sharkType);
  const sf2 = getSharkScaleForType(shark2.sharkType);

  // Coarse prune: sum of radii at current scale with a small safety pad (helps big sharks)
  const r1 = PLAYER_RADIUS * sf1;
  const r2 = PLAYER_RADIUS * sf2;
  const cx1 = shark1.x + r1, cy1 = shark1.y + r1;
  const cx2 = shark2.x + r2, cy2 = shark2.y + r2;
  const dx = cx2 - cx1, dy = cy2 - cy1;
  const pad = Math.max(2, Math.round(2 * Math.max(sf1, sf2))); // a few px to absorb rounding at high scales
  const maxR = r1 + r2 + pad;
  if ((dx * dx + dy * dy) > (maxR * maxR)) return false;

  // Setup transforms matching client: world = center + rotate(angle+PI) * (flipY * local)
  const a1 = shark1.angle;
  let deg1 = (a1 * 180 / Math.PI) % 360; if (deg1 < 0) deg1 += 360;
  const flipY1 = (deg1 > 270 || deg1 < 90) ? -1 : 1;
  const rot1 = a1 + Math.PI;
  const cos1Inv = Math.cos(-rot1), sin1Inv = Math.sin(-rot1); // inverse for mapping world->mask1
  const scale1 = SHARK_SCALE * sf1;

  const a2 = shark2.angle;
  let deg2 = (a2 * 180 / Math.PI) % 360; if (deg2 < 0) deg2 += 360;
  const flipY2 = (deg2 > 270 || deg2 < 90) ? -1 : 1;
  const rot2 = a2 + Math.PI;
  const cos2 = Math.cos(rot2), sin2 = Math.sin(rot2); // forward for mask2->world
  const scale2 = SHARK_SCALE * sf2;

  // Choose sampling step so the step in world space ~1px (denser for reliable baby + large sharks)
  const stepFor = (sf: number) => Math.max(1, Math.floor(1 / (SHARK_SCALE * sf)));
  const step1 = stepFor(sf1);
  const step2 = stepFor(sf2);

  // Neighborhood kernel increases for very large sharks to reduce misses on thin parts
  const kernelFor = (sf: number) => (sf >= 1.3 ? 2 : 1); // 3x3 or 5x5
  const k1 = kernelFor(sf1);
  const k2 = kernelFor(sf2);

  // Helper: sample src mask, project to dst mask, return true on first colored-over-colored hit
  const samplesHit = (
    srcMask: Uint8Array,
    srcCenterX: number, srcCenterY: number,
    srcCos: number, srcSin: number, srcFlipY: number, srcScale: number,
    dstMask: Uint8Array,
    dstCenterX: number, dstCenterY: number,
    dstCosInv: number, dstSinInv: number, dstFlipY: number, dstScale: number,
    step: number, kernel: number
  ): boolean => {
    for (let my = 0; my < SHARK_MASK_SIZE; my += step) {
      for (let mx = 0; mx < SHARK_MASK_SIZE; mx += step) {
        if (srcMask[my * SHARK_MASK_SIZE + mx] === 0) continue; // only colored pixels

        // Local (mask) -> local (world) in px
        const lx = (mx - SHARK_MASK_SIZE / 2) * srcScale;
        const ly = (my - SHARK_MASK_SIZE / 2) * srcScale;

        // Apply flip in local space, then rotation to world
        const lyF = ly * srcFlipY;
        const wx = srcCenterX + (lx * srcCos - lyF * srcSin);
        const wy = srcCenterY + (lx * srcSin + lyF * srcCos);

        // World -> dst local (inverse rotation then inverse flip)
        const vx = wx - dstCenterX;
        const vy = wy - dstCenterY;
        const rx = dstCosInv * vx - dstSinInv * vy;
        const ry = dstSinInv * vx + dstCosInv * vy;
        const lxD = rx;
        const lyD = ry * dstFlipY;

        // dst mask coordinates
        const mxD = (lxD / dstScale) + (SHARK_MASK_SIZE / 2);
        const myD = (lyD / dstScale) + (SHARK_MASK_SIZE / 2);
        const xi = Math.round(mxD);
        const yi = Math.round(myD);
        if (xi >= 0 && yi >= 0 && xi < SHARK_MASK_SIZE && yi < SHARK_MASK_SIZE) {
          if (dstMask[yi * SHARK_MASK_SIZE + xi] !== 0) return true;
          // Check neighborhood
          for (let oy = -kernel; oy <= kernel; oy++) {
            for (let ox = -kernel; ox <= kernel; ox++) {
              const tx = xi + ox, ty = yi + oy;
              if (tx < 0 || ty < 0 || tx >= SHARK_MASK_SIZE || ty >= SHARK_MASK_SIZE) continue;
              if (dstMask[ty * SHARK_MASK_SIZE + tx] !== 0) return true;
            }
          }
        }
      }
    }
    return false;
  };

  // Check both directions to avoid misses on thin geometry
  if (samplesHit(mask2, cx2, cy2, cos2, sin2, flipY2, scale2,
                 mask1, cx1, cy1, cos1Inv, sin1Inv, flipY1, scale1,
                 step2, k1)) return true;

  // Also sample mask1 against mask2 (swap roles)
  const cos1 = Math.cos(rot1), sin1 = Math.sin(rot1);
  const cos2Inv = Math.cos(-rot2), sin2Inv = Math.sin(-rot2);
  if (samplesHit(mask1, cx1, cy1, cos1, sin1, flipY1, scale1,
                 mask2, cx2, cy2, cos2Inv, sin2Inv, flipY2, scale2,
                 step1, k2)) return true;

  return false;
}

// --- Damage tracking and kill/assist awarding ---
function recordDamage(victimId: string, attackerId: string, amount: number, now: number) {
  if (!victimId || !attackerId) return;
  let m = damageByVictim.get(victimId);
  if (!m) { m = new Map(); damageByVictim.set(victimId, m); }
  const cur = m.get(attackerId) || { dmg: 0, last: 0 };
  cur.dmg += amount;
  cur.last = now;
  m.set(attackerId, cur);
}

function handleDeathAndAwards(victim: Player, killerId: string, now: number) {
  const victimScore = Math.max(0, victim.score | 0);
  const victimId = victim.id;
  const contrib = damageByVictim.get(victimId) || new Map<string, { dmg: number; last: number }>();
  // Consider only those who damaged within the assist window
  const recent: Array<{ id: string; dmg: number; last: number }> = [];
  for (const [aid, rec] of contrib.entries()) {
    if (now - rec.last <= ASSIST_WINDOW_MS) recent.push({ id: aid, dmg: rec.dmg, last: rec.last });
  }
  // Ensure killer is present in the set
  if (!recent.find(r => r.id === killerId)) recent.push({ id: killerId, dmg: 0, last: now });
  // Sort by damage descending
  recent.sort((a, b) => b.dmg - a.dmg);

  let mode: 'solo' | 'assist' | 'shared' = 'solo';
  let majority: { id: string; dmg: number } | null = null;
  let minority: { id: string; dmg: number } | null = null;
  if (recent.length >= 2) {
    const a = recent[0];
    const b = recent[1];
    // Tie: both around 50% of max HP (100)
    if (a.dmg >= 50 && b.dmg >= 50 && Math.abs(a.dmg - b.dmg) < 0.001) {
      mode = 'shared';
      majority = { id: a.id, dmg: a.dmg };
      minority = { id: b.id, dmg: b.dmg };
    } else if (b.dmg >= 35) { // Assist threshold: at least 35 damage within window
      mode = 'assist';
      majority = { id: a.id, dmg: a.dmg };
      minority = { id: b.id, dmg: b.dmg };
    }
  }

  // Compute awards
  let killerGain = 0, assistGain = 0;
  let assisterId: string | null = null;
  if (mode === 'solo') {
    killerGain = Math.floor(victimScore / 2);
  } else if (mode === 'shared' && majority && minority) {
    // 50/50 share of the 1/2 pool => each gets 1/4 victim score
    killerGain = Math.floor(victimScore / 4);
    assistGain = Math.floor(victimScore / 4);
    assisterId = minority.id === killerId ? majority.id : minority.id; // pick the other as assister for messaging
  } else if (mode === 'assist' && majority && minority) {
    // Majority gets 2/6, minority gets 1/6 (total 1/2 victim score)
    const majGain = Math.floor(victimScore * 2 / 6);
    const minGain = Math.floor(victimScore * 1 / 6);
    if (killerId === majority.id) {
      killerGain = majGain; assistGain = minGain; assisterId = minority.id;
    } else if (killerId === minority.id) {
      killerGain = minGain; assistGain = majGain; assisterId = majority.id;
    } else {
      // Edge case: killer not among top two (unlikely). Treat as solo kill.
      killerGain = Math.floor(victimScore / 2);
      mode = 'solo';
    }
  }

  // Apply gains
  const killer = gameState.players[killerId];
  if (killer && killerGain > 0) { killer.score = (killer.score || 0) + killerGain; }
  if (assisterId) {
    const assister = gameState.players[assisterId];
    if (assister && assistGain > 0) assister.score = (assister.score || 0) + assistGain;
  }

  // Emit kill feed + personal notifications
  const payload: any = {
    mode,
    victim: { id: victim.id, username: victim.username, score: victimScore },
  };
  if (killer) payload.killer = { id: killer.id, username: killer.username, gain: killerGain };
  if (assisterId) {
    const assister = gameState.players[assisterId];
    if (assister) payload.assister = { id: assister.id, username: assister.username, gain: assistGain };
  }
  io.emit('feed:kill', payload);

  // Local top notifications (5s)
  const killerSock = io.sockets.sockets.get(killerId);
  if (killerSock) killerSock.emit('notify', { type: 'kill', text: `You killed ${victim.username}`, ttlMs: 5000 });
  if (assisterId) {
    const assister = gameState.players[assisterId];
    const asSock = io.sockets.sockets.get(assisterId);
    if (assister && asSock && killer) {
      asSock.emit('notify', { type: 'assist', text: `You assisted ${killer.username} in killing ${victim.username}`, ttlMs: 5000 });
    }
  }

  // Cleanup damage logs for this victim
  damageByVictim.delete(victimId);
}


function ensureFoodPopulation() {
  const deficit = FOOD_TARGET_COUNT - Object.keys(gameState.foods).length;
  if (deficit > 0) {
    for (let i = 0; i < deficit; i++) spawnFoodDistributed();
  }
}

function ensureFoodPopulationInitial() {
  const deficit = FOOD_TARGET_COUNT - Object.keys(gameState.foods).length;
  if (deficit > 0) {
    for (let i = 0; i < deficit; i++) spawnFoodRandom();
  }
}

// Initialize fish schools and pre-seed foods
initFoodSchools();
ensureFoodPopulationInitial();

// Track whether the state changed since last tick to avoid redundant broadcasts
let dirty = false;

let foodsEmitAccum = 0;
let playersEmitAccum = 0;
const PLAYERS_EMIT_MS = 50; // reliable ~20 Hz players updates

const FOODS_EMIT_MS = 100; // emit foods at ~10 Hz to reduce bandwidth

// Gentle wandering movement for fish food (server-authoritative) with mild attraction to school centers
function updateFoods(dt: number): Array<{ id: number; x: number; y: number }> {
  const updates: Array<{ id: number; x: number; y: number }> = [];
  const PULL = 18; // px/s^2 (increased for stronger schooling behavior)
  const STEER = 4; // px/s^2 random steering
  const MAXS_WANDER = 20; // px/s
  const MAXS_FLEE = 130; // px/s (reduced to make fish easier to catch, still < shark SELF_SPEED)
  const FLEE_RADIUS = 520; // px, begin accelerating away when shark within this distance
  const FLEE_ACCEL = 280; // px/s^2, scaled by proximity
  const counts = countFoodsPerSchool();
  for (const f of Object.values(gameState.foods) as Food[]) {
    // If this food has not been assigned to a school yet (initial random spawn), assign it now
    if (typeof f.sid !== 'number' || typeof f.sx !== 'number' || typeof f.sy !== 'number') {
      const candidates: number[] = [];
      for (let i = 0; i < FOOD_SCHOOLS.length; i++) {
        if (i < perSchoolTarget.length && counts[i] < perSchoolTarget[i]) candidates.push(i);
      }
      let idx = 0;
      if (candidates.length) {
        idx = candidates[(Math.random() * candidates.length) | 0];
      } else {
        let min = Infinity; idx = 0;
        for (let i = 0; i < counts.length; i++) { if (counts[i] < min) { min = counts[i]; idx = i; } }
      }
      f.sid = idx; f.sx = FOOD_SCHOOLS[idx].x; f.sy = FOOD_SCHOOLS[idx].y; counts[idx] = (counts[idx] || 0) + 1;
    }

    if (typeof f.vx !== 'number' || typeof f.vy !== 'number') {
      const ang = Math.random() * Math.PI * 2;
      const sp = rand(8, 18);
      f.vx = Math.cos(ang) * sp;
      f.vy = Math.sin(ang) * sp;
    } else {
      // random steering noise
      f.vx += (Math.random() - 0.5) * STEER * dt;
      f.vy += (Math.random() - 0.5) * STEER * dt;
    }

    // Determine nearest shark and apply flee acceleration away from it (server-authoritative)
    let fleeing = false;
    let bestD2 = Infinity; let ax = 0, ay = 0;
    for (const p of Object.values(gameState.players) as Player[]) {
      const sf = getSharkScaleForType(p.sharkType);
      const cx = p.x + PLAYER_RADIUS * sf;
      const cy = p.y + PLAYER_RADIUS * sf;
      const ddx = f.x - cx, ddy = f.y - cy;
      const d2 = ddx*ddx + ddy*ddy;
      if (d2 < bestD2) { bestD2 = d2; ax = ddx; ay = ddy; }
    }
    if (bestD2 < (FLEE_RADIUS * FLEE_RADIUS)) {
      const dist = Math.sqrt(bestD2) || 1;
      const kProx = Math.max(0, 1 - dist / FLEE_RADIUS); // 0 far -> 1 very close
      const acc = FLEE_ACCEL * (0.4 + 0.6 * kProx); // gentle far, stronger when close
      f.vx += (ax / dist) * acc * dt;
      f.vy += (ay / dist) * acc * dt;
      fleeing = true;
    }

    // Strong attraction towards assigned school center (fish always want to regroup)
    {
      const dx = (f.sx as number) - f.x;
      const dy = (f.sy as number) - f.y;
      const d = Math.hypot(dx, dy) || 1;
      let k = (d > SCHOOL_RADIUS * 0.6) ? 1 : 0.4;
      if (fleeing) k *= 0.6; // still prioritize schooling even while fleeing (fish regroup after escape)
      f.vx += (dx / d) * PULL * k * dt;
      f.vy += (dy / d) * PULL * k * dt;
    }

    // cap speed and integrate
    const s = Math.hypot(f.vx || 0, f.vy || 0) || 1;
    const MAXS = fleeing ? MAXS_FLEE : MAXS_WANDER;
    if (s > MAXS) { f.vx = (f.vx || 0) / s * MAXS; f.vy = (f.vy || 0) / s * MAXS; }

    f.x += (f.vx || 0) * dt;
    f.y += (f.vy || 0) * dt;

    // Bounce inside map bounds (keep half-size margin)
    if (f.x < FOOD_HALF) { f.x = FOOD_HALF; if (typeof f.vx === 'number') f.vx = Math.abs(f.vx); }
    if (f.y < FOOD_HALF) { f.y = FOOD_HALF; if (typeof f.vy === 'number') f.vy = Math.abs(f.vy); }
    if (f.x > MAP_SIZE - FOOD_HALF) { f.x = MAP_SIZE - FOOD_HALF; if (typeof f.vx === 'number') f.vx = -Math.abs(f.vx); }
    if (f.y > MAP_SIZE - FOOD_HALF) { f.y = MAP_SIZE - FOOD_HALF; if (typeof f.vy === 'number') f.vy = -Math.abs(f.vy); }

    updates.push({ id: f.id, x: f.x, y: f.y });
  }
  return updates;
}

io.on('connection', (socket) => {
    const clientIp = socket.handshake.address;
    const transport = socket.conn.transport.name;
    const alloc = process.env.FLY_ALLOC_ID || 'local';
    console.log(`Player connected: ${socket.id} from ${clientIp} via ${transport} (alloc=${alloc}, pid=${process.pid})`);
    console.log(`Total players online: ${Object.keys(gameState.players).length + 1}`);


    // One-time latency probe handler
    socket.on('client:ping', (t0: number) => { socket.emit('server:pong', t0); });

    // Initialize new player
    socket.on('player:join', (username: string) => {
        // Validate and sanitize username (max 20 characters for in-game names)
        const sanitizedUsername = (username || 'Player').trim().slice(0, 20);

        console.log(`Player joining: ${sanitizedUsername} (${socket.id})`);

        // Spawn players in the center area of the map (avoid borders for better camera view)
        usernames.set(socket.id, sanitizedUsername);

        // Center spawn area: middle 60% of the map (20% margin from each edge)
        const spawnMargin = MAP_SIZE * 0.2;
        const spawnWidth = MAP_SIZE - (spawnMargin * 2) - SHARK_SIZE;
        const spawnHeight = MAP_SIZE - (spawnMargin * 2) - SHARK_SIZE;

        gameState.players[socket.id] = {
            id: socket.id,
            x: spawnMargin + Math.random() * spawnWidth,
            y: spawnMargin + Math.random() * spawnHeight,
            angle: 0,
            username: sanitizedUsername,
            score: 0,
            hp: 100,
            dead: false,
            level: 1,
            sharkType: 'Baby Shark.png',
            abilities: {
                quickDash: { cooldownUntil: 0, activeUntil: 0 },
                bubbleShield: { cooldownUntil: 0, activeUntil: 0 }
            }
        };

        console.log(`Player ${sanitizedUsername} spawned at (${gameState.players[socket.id].x}, ${gameState.players[socket.id].y})`);

        // Send current game state to the new player (include server timestamp for smoother client interpolation)

        lastUpdate.set(socket.id, Date.now());
        lastPos.set(socket.id, { x: gameState.players[socket.id].x, y: gameState.players[socket.id].y });


        lastShotAt.set(socket.id, 0);


        socket.emit('gameState', { ts: Date.now(), players: gameState.players, foods: Object.values(gameState.foods) });
        socket.emit('bubbles:init', BUBBLE_SEEDS);
        {
          const lb = Object.values(gameState.players)
            .sort((a,b) => b.score - a.score)
            .slice(0, 10)
            .map(p => ({ id: p.id, username: p.username, score: p.score }));
          socket.emit('leaderboard:update', lb);
        }

        // Broadcast new player to others
        dirty = true;
        socket.broadcast.emit('player:new', gameState.players[socket.id]);
        // Send level steps to the new player (client computes progress locally)
        if (LEVEL_STEPS.length > 0) socket.emit('levels:init', LEVEL_STEPS);

        // Send precomputed tail offsets and visual scales for all sharks
        try {
          const tails: Record<string, { x: number; y: number; s: number }> = {};
          const types = (SHARK_EVOLUTIONS && SHARK_EVOLUTIONS.length) ? SHARK_EVOLUTIONS : ['Baby Shark.png'];
          for (const type of types) {
            const off = sharkTailOffsets.get(type) || { x: -MOUTH_OFFSET_X, y: MOUTH_OFFSET_Y };
            tails[type] = { x: off.x, y: off.y, s: getSharkScaleForType(type) };
          }
          socket.emit('tails:init', tails);
        } catch (e) {
          console.warn('Failed to emit tails:init', e);
        }

        // Send collision masks for client-side visualization (debug mode)
        try {
          const masks: Record<string, string> = {};
          const types = (SHARK_EVOLUTIONS && SHARK_EVOLUTIONS.length) ? SHARK_EVOLUTIONS : ['Baby Shark.png'];
          for (const type of types) {
            const mask = sharkMasks.get(type);
            if (mask) {
              // Convert mask to base64 for transmission
              masks[type] = Buffer.from(mask).toString('base64');
            }
          }
          socket.emit('masks:init', { masks, size: SHARK_MASK_SIZE });
        } catch (e) {
          console.warn('Failed to emit masks:init', e);
        }
    });

    // Update player position and rotation
    socket.on('player:move', ({ x, y, angle }: { x: number, y: number, angle: number }) => {
        const me = gameState.players[socket.id];
        if (me) {
            // Clamp coordinates to map boundaries (top-left of shark; keep full sprite in-bounds)
            const s = getSharkScaleForType(me.sharkType);
            const effSize = Math.round(SHARK_SIZE * s);
            const clampedX = Math.max(0, Math.min(MAP_SIZE - effSize, x));
            const clampedY = Math.max(0, Math.min(MAP_SIZE - effSize, y));

            // Server-authoritative speed cap to prevent teleport/speed hacks
            const now = Date.now();
            const prevT = lastUpdate.get(socket.id) ?? now;
            const dt = Math.max(0, (now - prevT) / 1000);
            const prev = lastPos.get(socket.id) ?? { x: me.x, y: me.y };
            const dx = clampedX - prev.x;
            const dy = clampedY - prev.y;


            const dist = Math.hypot(dx, dy);
            // Allow higher speed during quickDash ability
            const isDashing = me.abilities?.quickDash && now < me.abilities.quickDash.activeUntil;
            const speedMultiplier = isDashing ? 3.5 : 1; // 3.5x speed during dash
            const maxDist = SELF_SPEED * dt * SPEED_TOL * speedMultiplier;
            let nx = clampedX, ny = clampedY;
            if (dist > maxDist) {
                const k = maxDist / (dist || 1);
                nx = prev.x + dx * k;
                ny = prev.y + dy * k;
            }

            // Check if new position would collide with any other shark
            // If so, block the movement (sharks are solid objects)
            // unguarded: rely on per-player masks (per-player masks checked inside sharkCollidesWithShark)
            {
                const tempPlayer = { ...me, x: nx, y: ny, angle };
                let blocked = false;
                let hitOther: Player | null = null;

                for (const other of Object.values(gameState.players)) {
                    if (other.id === socket.id || other.dead) continue;
                    if (sharkCollidesWithShark(tempPlayer, other)) {
                        blocked = true;
                        hitOther = other;
                        break;
                    }
                }

                // If movement is blocked, apply a two-sided knockback (no cooldown) and ensure separation (scaled)
                if (blocked && hitOther) {
                    const sMe = getSharkScaleForType(me.sharkType);
                    const sOt = getSharkScaleForType(hitOther.sharkType);
                    const cxMe = me.x + PLAYER_RADIUS * sMe, cyMe = me.y + PLAYER_RADIUS * sMe;
                    const cxOt = hitOther.x + PLAYER_RADIUS * sOt, cyOt = hitOther.y + PLAYER_RADIUS * sOt;
                    let dxk = cxMe - cxOt; let dyk = cyMe - cyOt;
                    const len = Math.hypot(dxk, dyk) || 1; dxk /= len; dyk /= len;
                    const KB = 70; // reduced knockback in pixels
                    const effSizeMe = Math.round(SHARK_SIZE * sMe);
                    const effSizeOt = Math.round(SHARK_SIZE * sOt);

                    // Initial symmetric push
                    let nx0 = Math.max(0, Math.min(MAP_SIZE - effSizeMe, me.x + dxk * KB));
                    let ny0 = Math.max(0, Math.min(MAP_SIZE - effSizeMe, me.y + dyk * KB));
                    let ox0 = Math.max(0, Math.min(MAP_SIZE - effSizeOt, hitOther.x - dxk * KB));
                    let oy0 = Math.max(0, Math.min(MAP_SIZE - effSizeOt, hitOther.y - dyk * KB));

                    // Ensure at least circle separation to avoid lingering overlap
                    let ncx = nx0 + PLAYER_RADIUS * sMe, ncy = ny0 + PLAYER_RADIUS * sMe;
                    let ocx = ox0 + PLAYER_RADIUS * sOt, ocy = oy0 + PLAYER_RADIUS * sOt;
                    let sdx = ncx - ocx, sdy = ncy - ocy;
                    let dist = Math.hypot(sdx, sdy) || 1;
                    const target = PLAYER_RADIUS * sMe + PLAYER_RADIUS * sOt + 1; // +1px margin
                    if (dist < target) {
                        const need = (target - dist) / 2;
                        sdx /= dist; sdy /= dist;
                        nx0 = Math.max(0, Math.min(MAP_SIZE - effSizeMe, nx0 + sdx * need));
                        ny0 = Math.max(0, Math.min(MAP_SIZE - effSizeMe, ny0 + sdy * need));
                        ox0 = Math.max(0, Math.min(MAP_SIZE - effSizeOt, ox0 - sdx * need));
                        oy0 = Math.max(0, Math.min(MAP_SIZE - effSizeOt, oy0 - sdy * need));
                    }

                    nx = nx0; ny = ny0;
                    hitOther.x = ox0; hitOther.y = oy0;
                    // Keep the other player's speed limiter in sync
                    lastPos.set(hitOther.id, { x: hitOther.x, y: hitOther.y });
                    lastUpdate.set(hitOther.id, now);

                    // Apply collision damage to both sharks (no cooldown)
                    me.hp = Math.max(0, (me.hp ?? 100) - SHARK_COLLISION_DAMAGE);
                    hitOther.hp = Math.max(0, (hitOther.hp ?? 100) - SHARK_COLLISION_DAMAGE);

                    console.log(`Collision: ${me.username} (${me.hp}HP) <-> ${hitOther.username} (${hitOther.hp}HP)`);

                    // Record damage for kill/assist tracking
                    recordDamage(me.id, hitOther.id, SHARK_COLLISION_DAMAGE, now);
                    recordDamage(hitOther.id, me.id, SHARK_COLLISION_DAMAGE, now);

                    // Emit collision event to both players for visual effects
                    const meSock = io.sockets.sockets.get(me.id);
                    const otherSock = io.sockets.sockets.get(hitOther.id);
                    if (meSock) meSock.emit('shark:collision', { damage: SHARK_COLLISION_DAMAGE });
                    if (otherSock) otherSock.emit('shark:collision', { damage: SHARK_COLLISION_DAMAGE });

                    dirty = true; // HP changed, need to broadcast

                    // Check for deaths
                    if (me.hp <= 0 && !me.dead) {
                        me.dead = true;
                        const s = io.sockets.sockets.get(me.id);
                        s?.emit('player:died');
                        try { handleDeathAndAwards(me, hitOther.id, now); } catch {}
                        // Remove bubbles and state
                        for (const bid of Object.keys(bubbles)) {
                            if (bubbles[Number(bid)]?.ownerId === me.id) { delete bubbles[Number(bid)]; projDirty = true; }
                        }
                        lastShotAt.delete(me.id);
                        lastUpdate.delete(me.id);
                        lastPos.delete(me.id);
                        setTimeout(() => {
                            delete gameState.players[me.id];
                            io.emit('player:left', me.id);
                        }, 1200);
                    }
                    if (hitOther.hp <= 0 && !hitOther.dead) {
                        hitOther.dead = true;
                        const s = io.sockets.sockets.get(hitOther.id);
                        s?.emit('player:died');
                        try { handleDeathAndAwards(hitOther, me.id, now); } catch {}
                        // Remove bubbles and state
                        for (const bid of Object.keys(bubbles)) {
                            if (bubbles[Number(bid)]?.ownerId === hitOther.id) { delete bubbles[Number(bid)]; projDirty = true; }
                        }
                        lastShotAt.delete(hitOther.id);
                        lastUpdate.delete(hitOther.id);
                        lastPos.delete(hitOther.id);
                        setTimeout(() => {
                            delete gameState.players[hitOther.id];
                            io.emit('player:left', hitOther.id);
                        }, 1200);
                    }
                } else if (blocked) {
                    nx = me.x;
                    ny = me.y;
                }

            }

            me.x = nx;
            me.y = ny;
            me.angle = angle;

            lastUpdate.set(socket.id, now);
            lastPos.set(socket.id, { x: me.x, y: me.y });

            // Movement update complete; mark dirty for broadcast
            dirty = true;

        }
    });

        // Client-reported eat request — server verifies with pixel-perfect mask overlap
        socket.on('player:eat', (foodId: number) => {
            const me = gameState.players[socket.id];
            const food = gameState.foods[Number(foodId)];
            if (!me || !food) return;

            // Coarse range check first (scaled radius) to avoid heavy math when far
            const sf = getSharkScaleForType(me.sharkType);
            const cx = me.x + PLAYER_RADIUS * sf, cy = me.y + PLAYER_RADIUS * sf;
            const dx = cx - food.x;
            const dy = cy - food.y;
            const maxR = PLAYER_RADIUS * sf + FOOD_HALF + 18; // small slack
            if ((dx*dx + dy*dy) > (maxR*maxR)) return;

            // Server-authoritative pixel-perfect verification using binary masks
            if (pixelPerfectOverlap(me, food)) {
                if (gameState.foods[food.id]) handleConsume(me, food);
            }
        });



    // Client requests to shoot toward a world-space target (server-authoritative)
    socket.on('player:shoot', ({ tx, ty }: { tx: number; ty: number }) => {
        const me = gameState.players[socket.id];
        if (!me || me.dead) return;
        const now = Date.now();
        const last = lastShotAt.get(socket.id) || 0;
        const timeSinceLastShot = now - last;

        // Add small tolerance (50ms) to account for network latency and timing drift
        if (timeSinceLastShot < SHOOT_COOLDOWN_MS - 50) {
            // console.log(`Shot rejected for ${socket.id}: ${timeSinceLastShot}ms < ${SHOOT_COOLDOWN_MS}ms`);
            return; // cooldown enforcement
        }

        lastShotAt.set(socket.id, now);

        // Spawn bubble at mouth offset rotated by (angle + 180deg)
        // Get mouth offset for current shark type
        const mouthOffset = sharkMouthOffsets.get(me.sharkType) || { x: MOUTH_OFFSET_X, y: MOUTH_OFFSET_Y };
        const rot = me.angle + Math.PI;
        const cos = Math.cos(rot), sin = Math.sin(rot);
        const sf = getSharkScaleForType(me.sharkType);
        const cx = me.x + PLAYER_RADIUS * sf, cy = me.y + PLAYER_RADIUS * sf;

        // Account for horizontal flip when shark is facing right
        const a = me.angle;
        let deg = (a * 180 / Math.PI) % 360;
        if (deg < 0) deg += 360;
        const flipY = (deg > 270 || deg < 90) ? -1 : 1; // right-facing quadrants => flip

        // Apply flip to mouth Y offset (X stays the same)
        const mouthX = mouthOffset.x * SHARK_SCALE * sf;
        const mouthY = mouthOffset.y * SHARK_SCALE * sf * flipY; // Apply flip to Y

        // Calculate mouth position in world space
        const sx = cx + (mouthX * cos + mouthY * -sin);
        const sy = cy + (mouthX * sin + mouthY * cos);

        // Calculate direction from mouth to target
        const dx = (tx - sx), dy = (ty - sy);
        const targetAngle = Math.atan2(dy, dx);

        // Implement firing arc constraint: bullets can only fire within ±90° of shark's forward direction
        // Shark's forward direction is me.angle
        let angleDiff = targetAngle - me.angle;
        // Normalize angle difference to [-PI, PI]
        while (angleDiff > Math.PI) angleDiff -= 2 * Math.PI;
        while (angleDiff < -Math.PI) angleDiff += 2 * Math.PI;

        // If cursor is outside ±90° arc, clamp to nearest valid angle
        const maxAngleDiff = Math.PI / 2; // 90 degrees
        let finalAngle = targetAngle;
        if (Math.abs(angleDiff) > maxAngleDiff) {
            // Clamp to the nearest edge of the firing arc
            finalAngle = me.angle + (angleDiff > 0 ? maxAngleDiff : -maxAngleDiff);
        }

        // Calculate velocity using the final angle
        const vx = Math.cos(finalAngle) * BUBBLE_SPEED;
        const vy = Math.sin(finalAngle) * BUBBLE_SPEED;

        const id = nextBubbleId++;
        bubbles[id] = { id, ownerId: socket.id, x: sx, y: sy, vx, vy, expireAt: now + BUBBLE_TTL_MS };
    });

    // Developer testing feature: z key grants +1 level (WarriorX12 only)
    socket.on('dev:levelup', async () => {
        const me = gameState.players[socket.id];
        if (!me || me.dead) return;

        // Restrict to WarriorX12 only
        if (me.username !== 'WarriorX12') {
            console.log(`Unauthorized levelup attempt by ${me.username}`);
            return;
        }

        const oldLevel = me.level || 1;
        const newLevel = Math.min(100, oldLevel + 1);
        me.level = newLevel;

        // Update score to match the new level
        let totalXP = 0;
        for (let i = 0; i < newLevel - 1 && i < LEVEL_STEPS.length; i++) {
            totalXP += LEVEL_STEPS[i];
        }
        me.score = totalXP;

        // Check for evolution
        const newSharkType = getSharkTypeForLevel(newLevel);
        if (newSharkType !== me.sharkType) {
            me.sharkType = newSharkType;
            await loadSharkMask(newSharkType).catch(err => console.error('Failed to load shark mask:', err));

            // Get tail offset for client-side trail bubbles
            const tailOffset = sharkTailOffsets.get(newSharkType) || { x: -MOUTH_OFFSET_X, y: MOUTH_OFFSET_Y };

            // Emit server-authoritative smoke effect visible to all
            io.emit('effect:smoke', { x: me.x, y: me.y, playerId: me.id, s: getSharkScaleForType(newSharkType) });

            // Emit evolution event (with tail offset)
            io.emit('player:evolved', {
                id: me.id,
                username: me.username,
                level: newLevel,
                sharkType: newSharkType,
                x: me.x,
                y: me.y,
                tailOffset
            });

            console.log(`[DEV] ${me.username} evolved to ${newSharkType} at level ${newLevel}`);
        }

        console.log(`[DEV] ${me.username} leveled up to ${newLevel} (score: ${me.score})`);
        dirty = true;
    });

    // Ability activation
    socket.on('ability:activate', (data: { abilityId: 'quickDash' | 'bubbleShield' }) => {
        const me = gameState.players[socket.id];
        if (!me || me.dead) return;
        if (!abilitiesConfig) return;

        const { abilityId } = data;
        const now = Date.now();

        // Validate ability exists
        if (!me.abilities || !me.abilities[abilityId]) return;

        const abilityState = me.abilities[abilityId];
        const config = abilitiesConfig.abilities[abilityId];

        // Check cooldown
        if (now < abilityState.cooldownUntil) {
            console.log(`[Ability] ${me.username} tried to use ${abilityId} but it's on cooldown`);
            return;
        }

        // Check if already active
        if (now < abilityState.activeUntil) {
            console.log(`[Ability] ${me.username} tried to use ${abilityId} but it's already active`);
            return;
        }

        // Activate ability
        const durationMs = config.durationSeconds * 1000;
        const cooldownMs = config.cooldownSeconds * 1000;

        abilityState.activeUntil = now + durationMs;
        abilityState.cooldownUntil = now + durationMs + cooldownMs;

        console.log(`[Ability] ${me.username} activated ${abilityId}`);

        // Apply ability-specific effects
        if (abilityId === 'quickDash') {
            // Speed boost is handled client-side for smooth visuals
            // Server just tracks the state
        } else if (abilityId === 'bubbleShield') {
            // Shield state is tracked, collision logic will check this
        }

        // Broadcast ability activation to all clients
        io.emit('ability:activated', {
            playerId: socket.id,
            abilityId,
            activeUntil: abilityState.activeUntil,
            cooldownUntil: abilityState.cooldownUntil
        });

        dirty = true;
    });

    // Player respawn request (after death)
    socket.on('player:respawn', () => {
        console.log(`Respawn request from ${socket.id}`);
        let me = gameState.players[socket.id];
        console.log(`Player state:`, me ? `exists, dead=${me.dead}` : 'does not exist');

        // Only prevent respawn if player exists AND is alive (not dead)
        if (me && !me.dead) {
            console.log(`Player ${socket.id} is already alive, ignoring respawn`);
            return; // already alive
        }

        const username = usernames.get(socket.id) || 'Player';
        console.log(`Respawning player ${username} (${socket.id})`);

        // Center spawn area: middle 60% of the map (20% margin from each edge)
        const spawnMargin = MAP_SIZE * 0.2;
        const spawnWidth = MAP_SIZE - (spawnMargin * 2) - SHARK_SIZE;
        const spawnHeight = MAP_SIZE - (spawnMargin * 2) - SHARK_SIZE;

        me = gameState.players[socket.id] = {
            id: socket.id,
            x: spawnMargin + Math.random() * spawnWidth,
            y: spawnMargin + Math.random() * spawnHeight,
            angle: 0,
            username,
            score: 0,
            hp: 100,
            dead: false,
            level: 1,
            sharkType: 'Baby Shark.png',
            abilities: {
                quickDash: { cooldownUntil: 0, activeUntil: 0 },
                bubbleShield: { cooldownUntil: 0, activeUntil: 0 }
            }
        } as Player;
        lastUpdate.set(socket.id, Date.now());
        lastPos.set(socket.id, { x: me.x, y: me.y });
        lastShotAt.set(socket.id, 0);

        console.log(`Emitting player:respawned to ${socket.id} at (${me.x}, ${me.y})`);
        socket.emit('player:respawned', { x: me.x, y: me.y, hp: me.hp });
        socket.broadcast.emit('player:new', me);
        dirty = true;
    });

    // Handle disconnection
    socket.on('disconnect', (reason) => {
        const username = usernames.get(socket.id) || 'Unknown';
        console.log(`Player disconnected: ${username} (${socket.id}) - Reason: ${reason}`);
        console.log(`Total players remaining: ${Object.keys(gameState.players).length - 1}`);

        // Remove player's active bubbles and cooldown entry
        for (const id of Object.keys(bubbles)) { if (bubbles[Number(id)]?.ownerId === socket.id) delete bubbles[Number(id)]; }
        lastShotAt.delete(socket.id);
        lastUpdate.delete(socket.id);
        lastPos.delete(socket.id);
        usernames.delete(socket.id);
        delete gameState.players[socket.id];
        dirty = true;
        io.emit('player:left', socket.id);
    });
});

// Broadcast players and projectiles at a fixed tick rate using volatile messages
const TICK_MS = 33; // 30 ticks per second for smoother gameplay
setInterval(() => {
    const dt = TICK_MS / 1000;
    const now = Date.now();

    // Update bubbles (movement, TTL, collisions)
    const updates: Array<{ id: number; x: number; y: number }> = [];
    for (const key of Object.keys(bubbles)) {
        const id = Number(key);
        const b = bubbles[id];
        if (!b) continue;
        if (now >= b.expireAt) { delete bubbles[id]; projDirty = true; continue; }

        // Calculate new position
        const newX = b.x + b.vx * dt;
        const newY = b.y + b.vy * dt;

        // Check map boundaries before moving
        if (newX < 0 || newY < 0 || newX > MAP_SIZE || newY > MAP_SIZE) {
            delete bubbles[id];
            projDirty = true;
            continue;
        }

        // Enhanced collision detection: check along the bullet's path to prevent tunneling
        // Sample multiple points between old and new position for fast-moving bullets
        let hit = false;
        const steps = 3; // Check 3 intermediate points along the path
        for (let step = 0; step <= steps && !hit; step++) {
            const t = step / steps;
            const checkX = b.x + (newX - b.x) * t;
            const checkY = b.y + (newY - b.y) * t;

            for (const p of Object.values(gameState.players)) {
                if (!p || p.id === b.ownerId || p.dead) continue;
                if (bubbleHitsShark(p, checkX, checkY)) {
                    // Check if player has active bubble shield
                    const hasShield = p.abilities?.bubbleShield && now < p.abilities.bubbleShield.activeUntil;

                    if (hasShield && p.abilities?.bubbleShield) {
                        // Shield blocks the bullet - deactivate shield immediately
                        p.abilities.bubbleShield.activeUntil = 0;

                        // Get player's scale for effect positioning
                        const sf = getSharkScaleForType(p.sharkType);
                        const centerX = p.x + PLAYER_RADIUS * sf;
                        const centerY = p.y + PLAYER_RADIUS * sf;

                        // Broadcast shield pop effect to all clients
                        io.emit('effect:shield-pop', {
                            playerId: p.id,
                            x: centerX,
                            y: centerY,
                            scale: sf
                        });

                        // Broadcast shield deactivation
                        io.emit('ability:deactivated', {
                            playerId: p.id,
                            abilityId: 'bubbleShield',
                            reason: 'hit'
                        });

                        console.log(`[Ability] ${p.username}'s bubble shield blocked a hit`);
                    } else {
                        // No shield - deal damage
                        recordDamage(p.id, b.ownerId, BULLET_DAMAGE, now);
                        p.hp = Math.max(0, (p.hp ?? 100) - BULLET_DAMAGE);
                    }

                    // ALWAYS delete the bullet on contact immediately - no delay
                    delete bubbles[id];
                    projDirty = true;
                    io.emit('projectile:removed', id); // Immediate removal on client
                    dirty = true; // player state changed
                    hit = true;

                    // Handle death (only if no shield or shield didn't prevent damage)
                    if (!hasShield && p.hp <= 0) {
                        const dyingId = p.id;
                        const s = io.sockets.sockets.get(dyingId);
                        s?.emit('player:died');

                        // Mark player as dead but keep in game state for animation
                        p.dead = true;

                        // Award kill/assists
                        try { handleDeathAndAwards(p, b.ownerId, now); } catch {}

                        // Remove this player's active bubbles and cooldown/state
                        for (const bid of Object.keys(bubbles)) {
                            if (bubbles[Number(bid)]?.ownerId === dyingId) { delete bubbles[Number(bid)]; projDirty = true; }
                        }
                        lastShotAt.delete(dyingId);
                        lastUpdate.delete(dyingId);
                        lastPos.delete(dyingId);

                        // Remove player from game state after death animation completes (1.2s)
                        setTimeout(() => {
                            delete gameState.players[dyingId];
                            io.emit('player:left', dyingId);
                        }, 1200);
                    }
                    break;
                }
            }
        }

        // Check fish collision if bullet hasn't hit a player yet
        if (!hit && bubbles[id]) {
            for (const food of Object.values(gameState.foods) as Food[]) {
                // Check collision at multiple points along the bullet's path
                for (let step = 0; step <= steps && !hit; step++) {
                    const t = step / steps;
                    const checkX = b.x + (newX - b.x) * t;
                    const checkY = b.y + (newY - b.y) * t;

                    if (bubbleHitsFish(food, checkX, checkY)) {
                        // Delete the bullet and notify clients immediately
                        delete bubbles[id];
                        projDirty = true;
                        io.emit('projectile:removed', id); // Immediate removal on client

                        // Award score to the shooter and handle fish respawn
                        const shooter = gameState.players[b.ownerId];
                        if (shooter) {
                            handleConsume(shooter, food);
                        } else {
                            // Shooter disconnected, just respawn the fish
                            delete gameState.foods[food.id];
                            const newFood = spawnFoodDistributed();
                            io.emit('food:respawn', { removedId: food.id, food: newFood });
                        }

                        hit = true;
                        break;
                    }
                }
                if (hit) break;
            }
        }

        // Only update position and send to clients if no collision
        if (!hit && bubbles[id]) {
            b.x = newX;
            b.y = newY;
            updates.push({ id, x: b.x, y: b.y });
        }
    }

    // Emit projectiles to all clients; if there were removals but no movers, send empty to clear stale
    if (updates.length > 0 || projDirty) {
      io.volatile.compress(false).emit('projectiles:update', updates);
      projDirty = false;
    }

    // Shark-to-shark collision is now handled in player:move to prevent overlap
    // No need for post-movement collision detection since movement is blocked

    // Update fish food wander and emit positions at a modest cadence
    const foodUpdates = updateFoods(dt);
    foodsEmitAccum += TICK_MS;
    if (foodsEmitAccum >= FOODS_EMIT_MS && foodUpdates.length) {
      io.volatile.compress(false).emit('foods:update', foodUpdates);
      foodsEmitAccum = 0;
    }

    // Players broadcast if state changed (reliable at ~20 Hz)
    if (dirty) {
        playersEmitAccum += TICK_MS;
        if (playersEmitAccum >= PLAYERS_EMIT_MS) {
          dirty = false;
          playersEmitAccum = 0;
          io.compress(false).emit('players:update', { ts: Date.now(), players: gameState.players });
          // Server-side leaderboard (top 10 by score) — reliable emit (non-volatile)
          const lb = Object.values(gameState.players)
            .sort((a,b) => b.score - a.score)
            .slice(0, 10)
            .map(p => ({ id: p.id, username: p.username, score: p.score }));
          io.compress(false).emit('leaderboard:update', lb);
        }
    }

}, TICK_MS);

// Reliable periodic leaderboard broadcast to heal any dropped UI updates (non-volatile)
setInterval(() => {
  const lb = Object.values(gameState.players)
    .sort((a,b) => b.score - a.score)
    .slice(0, 10)
    .map(p => ({ id: p.id, username: p.username, score: p.score }));
  io.compress(false).emit('leaderboard:update', lb);
}, 1000);





// Kick off server-side mask loading and continuous collision checks
loadServerMasks().catch(() => {});
loadLevelProgression().catch(() => {});
loadAbilitiesConfig().catch(() => {});
loadSharkEvolutions()
  .then(() => preloadAllSharkMasks())
  .catch(() => {});

setInterval(() => {
  if (!foodMask) return;
  const foodsArr = Object.values(gameState.foods);
  if (foodsArr.length === 0) return;
  for (const me of Object.values(gameState.players)) {
    const s = getSharkScaleForType(me.sharkType);
    const cx = me.x + PLAYER_RADIUS * s, cy = me.y + PLAYER_RADIUS * s;
    for (const food of foodsArr) {
      const dx = cx - food.x, dy = cy - food.y;
      const maxR = PLAYER_RADIUS * s + FOOD_HALF + 16;
      if ((dx*dx + dy*dy) > (maxR*maxR)) continue;
      if (pixelPerfectOverlap(me, food)) {
        if (!gameState.foods[food.id]) continue;
        handleConsume(me, food);
      }
    }
  }
}, TICK_MS);


// Use environment PORT for production, fallback to 3000 for local dev
const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';

httpServer.listen(PORT, HOST, () => {
    console.log('='.repeat(60));
    console.log(`🚀 Unified server (Static + Game) running on ${HOST}:${PORT}`);
    console.log(`📦 Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`🎮 Map size: ${MAP_SIZE}x${MAP_SIZE} pixels`);
    console.log(`🦈 Shark evolutions: ${SHARK_EVOLUTIONS.length} types loaded`);
    console.log(`📊 Level steps: ${LEVEL_STEPS.length} levels configured`);
    console.log(`🌐 CORS origins: ${allowedOrigins.join(', ')}`);
    console.log(`🔌 Socket.IO transports: websocket, polling`);
    console.log(`⚡ Tick rate: ${TICK_MS}ms (${Math.round(1000/TICK_MS)} FPS)`);
    console.log(`✅ Static files, API, and Socket.IO game server ready!`);
    console.log('='.repeat(60));
});
