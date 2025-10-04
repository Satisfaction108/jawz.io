import { Server } from 'socket.io';
import { createServer, IncomingMessage, ServerResponse } from 'http';
import { promises as fsp } from 'fs';
import * as path from 'path';
import { extname, join, normalize } from 'path';
import { createReadStream, existsSync, statSync } from 'fs';

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
}

interface Food { id: number; x: number; y: number; vx?: number; vy?: number; }

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
let SHARK_EVOLUTIONS: string[] = [];

function getSharkScaleForType(type: string | undefined): number {
  if (!type || !SHARK_EVOLUTIONS || SHARK_EVOLUTIONS.length === 0) return 1.0;
  const idx = SHARK_EVOLUTIONS.indexOf(type);
  if (idx < 0) return 1.0;
  // Smooth progression: 1.00 at index 0 → ~1.38 at index 19
  return Math.min(1.4, 1.0 + 0.02 * idx);
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

function computeMouthAnchorFromMask(mask: Uint8Array, size: number): { x: number; y: number } {
  // Find leftmost opaque edge across rows; pick median row among those near the global minX (within 2px)
  let minX = size, rows: number[] = [];
  const leftmost = new Array<number>(size).fill(size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (mask[y * size + x] !== 0) { leftmost[y] = x; if (x < minX) minX = x; break; }
    }
  }
  for (let y = 0; y < size; y++) if (leftmost[y] <= minX + 2) rows.push(y);
  const yMed = rows.length ? rows[Math.floor(rows.length / 2)] : Math.round(size / 2);
  return { x: minX, y: yMed };
}

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

// Compute tail anchor from mask (rightmost opaque edge, median row)
function computeTailAnchorFromMask(mask: Uint8Array, size: number): { x: number; y: number } {
  let maxX = -1, rows: number[] = [];
  const rightmost = new Array<number>(size).fill(-1);
  for (let y = 0; y < size; y++) {
    for (let x = size - 1; x >= 0; x--) {
      if (mask[y * size + x] !== 0) {
        rightmost[y] = x;
        if (x > maxX) maxX = x;
        break;
      }
    }
  }
  for (let y = 0; y < size; y++) if (rightmost[y] >= maxX - 2) rows.push(y);
  const yMed = rows.length ? rows[Math.floor(rows.length / 2)] : Math.round(size / 2);
  return { x: maxX, y: yMed };
}

// Load a specific shark's mask and compute mouth/tail positions
async function loadSharkMask(sharkFilename: string): Promise<void> {
  if (sharkMasks.has(sharkFilename)) return; // already loaded

  try {
    // Mask files are lowercase, PNG files are capitalized
    const baseName = sharkFilename.replace('.png', '.txt').toLowerCase();
    const maskPath = path.join('server', 'sharks', baseName);
    const txt = await fsp.readFile(maskPath, 'utf8');
    const mask = parseBinaryMask(txt, SHARK_MASK_SIZE, SHARK_MASK_SIZE);
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

    console.log(`Loaded mask for ${sharkFilename}`);
  } catch (e) {
    console.error(`Failed to load mask for ${sharkFilename}`, e);
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
    const sharkTxt = await fsp.readFile('server/sharks/baby shark.txt', 'utf8');
    const rawShark = parseBinaryMask(sharkTxt, SHARK_MASK_SIZE, SHARK_MASK_SIZE);
    sharkMask = rawShark;
    try {
      const mouth = computeMouthAnchorFromMask(sharkMask, SHARK_MASK_SIZE);
      // Mouth is in mask space, keep it there (will scale when using)
      MOUTH_OFFSET_X = mouth.x - (SHARK_MASK_SIZE / 2);
      MOUTH_OFFSET_Y = mouth.y - (SHARK_MASK_SIZE / 2);
    } catch {}

  } catch (e) {
    console.error('Failed to load shark mask from server/sharks/baby shark.txt', e);
    sharkMask = null;
  }
  try {
    const foodTxt = await fsp.readFile('server/food/FishFood.txt', 'utf8');
    const rawFood = parseBinaryMask(foodTxt, 64, 64);
    foodMask = resampleNearest(rawFood, 64, 64, FOOD_SIZE, FOOD_SIZE);
  } catch (e) {
    console.error('Failed to load food mask from server/food/FishFood.txt', e);
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

      // Food pixel world position (center of pixel)
      const wx = food.x + fx + 0.5;
      const wy = food.y + fy + 0.5;

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

const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const url = req.url || '/';
  const method = (req.method || 'GET').toUpperCase();

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
    ? [
        process.env.FRONTEND_URL || 'https://jawz-io.fly.dev',
        'https://jawz-io.fly.dev',
        'https://jawz.onrender.com',
        'https://jawz-io.onrender.com'
      ]
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
    allowEIO3: true
});

const gameState: GameState = {
    players: {},
    foods: {}
};
let nextFoodId = 1;

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
    const m = 120; // margin from edges (slightly larger than player radius)
    let best: { x: number; y: number; score: number } | null = null;
    for (let i = 0; i < tries; i++) {
        const cx = rand(m, MAP_SIZE - m);
        const cy = rand(m, MAP_SIZE - m);
        const score = nearestDistSq(cx, cy);
        if (!best || score > best.score) best = { x: cx, y: cy, score };
    }
    const ang = Math.random() * Math.PI * 2;
    const speed = rand(8, 18); // px/s, gentle drift
    const food: Food = { id: nextFoodId++, x: best!.x, y: best!.y, vx: Math.cos(ang) * speed, vy: Math.sin(ang) * speed };
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

// Pixel-perfect shark-to-shark collision detection (scaled)
function sharkCollidesWithShark(shark1: Player, shark2: Player): boolean {
  const mask1 = getPlayerMask(shark1);
  const mask2 = getPlayerMask(shark2);
  if (!mask1 || !mask2) return false;

  const sf1 = getSharkScaleForType(shark1.sharkType);
  const sf2 = getSharkScaleForType(shark2.sharkType);
  // Coarse prune: sum of radii at current scale
  const cx1 = shark1.x + PLAYER_RADIUS * sf1, cy1 = shark1.y + PLAYER_RADIUS * sf1;
  const cx2 = shark2.x + PLAYER_RADIUS * sf2, cy2 = shark2.y + PLAYER_RADIUS * sf2;
  const dx = cx2 - cx1, dy = cy2 - cy1;
  const maxR = PLAYER_RADIUS * (sf1 + sf2);
  if ((dx * dx + dy * dy) > (maxR * maxR)) return false;

  // Setup transforms for both sharks
  const a1 = shark1.angle;
  let deg1 = (a1 * 180 / Math.PI) % 360; if (deg1 < 0) deg1 += 360;
  const flipY1 = (deg1 > 270 || deg1 < 90) ? -1 : 1;
  const rot1 = a1 + Math.PI;
  const cos1Inv = Math.cos(-rot1), sin1Inv = Math.sin(-rot1);
  const scale1 = SHARK_SCALE * sf1;

  const a2 = shark2.angle;
  let deg2 = (a2 * 180 / Math.PI) % 360; if (deg2 < 0) deg2 += 360;
  const flipY2 = (deg2 > 270 || deg2 < 90) ? -1 : 1;
  const rot2 = a2 + Math.PI;
  const cos2 = Math.cos(rot2), sin2 = Math.sin(rot2);
  const scale2 = SHARK_SCALE * sf2;

  // Adaptive sampling: denser for larger sharks
  const maxScale = Math.max(sf1, sf2);
  const step = maxScale > 1.3 ? 1 : (maxScale > 1.2 ? 2 : (maxScale > 1.1 ? 3 : 4));

  // Sample shark2's mask pixels and check against shark1
  for (let my = 0; my < SHARK_MASK_SIZE; my += step) {
    for (let mx = 0; mx < SHARK_MASK_SIZE; mx += step) {
      if (mask2[my * SHARK_MASK_SIZE + mx] === 0) continue;

      // Convert shark2 mask coords to local coords
      const lx2 = (mx - SHARK_MASK_SIZE / 2) * scale2;
      const ly2 = (my - SHARK_MASK_SIZE / 2) * scale2;

      // Apply shark2's flip and rotation to get world position
      const ly2_flipped = ly2 * flipY2;
      const wx = cx2 + (lx2 * cos2 - ly2_flipped * sin2);
      const wy = cy2 + (lx2 * sin2 + ly2_flipped * cos2);

      // Transform world point to shark1's local space
      const vx = wx - cx1;
      const vy = wy - cy1;

      // Apply inverse rotation for shark1
      const rx1 = cos1Inv * vx - sin1Inv * vy;
      const ry1 = sin1Inv * vx + cos1Inv * vy;

      // Apply inverse flip for shark1
      const lx1 = rx1;
      const ly1 = ry1 * flipY1;

      // Convert to shark1's mask coordinates
      const mx1 = (lx1 / scale1) + (SHARK_MASK_SIZE / 2);
      const my1 = (ly1 / scale1) + (SHARK_MASK_SIZE / 2);

      // Check center pixel
      const mx1i = Math.round(mx1);
      const my1i = Math.round(my1);
      if (mx1i >= 0 && my1i >= 0 && mx1i < SHARK_MASK_SIZE && my1i < SHARK_MASK_SIZE) {
        if (mask1[my1i * SHARK_MASK_SIZE + mx1i] !== 0) return true;
      }

      // Check 3x3 neighborhood for sub-pixel accuracy
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const tx = mx1i + dx;
          const ty = my1i + dy;
          if (tx >= 0 && ty >= 0 && tx < SHARK_MASK_SIZE && ty < SHARK_MASK_SIZE) {
            if (mask1[ty * SHARK_MASK_SIZE + tx] !== 0) return true;
          }
        }
      }
    }
  }

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

// Pre-seed foods
ensureFoodPopulation();

// Track whether the state changed since last tick to avoid redundant broadcasts
let dirty = false;

let foodsEmitAccum = 0;
const FOODS_EMIT_MS = 100; // emit foods at ~10 Hz to reduce bandwidth

// Gentle wandering movement for fish food (server-authoritative)
function updateFoods(dt: number): Array<{ id: number; x: number; y: number }> {
  const updates: Array<{ id: number; x: number; y: number }> = [];
  for (const f of Object.values(gameState.foods) as Food[]) {
    if (typeof f.vx !== 'number' || typeof f.vy !== 'number') {
      const ang = Math.random() * Math.PI * 2;
      const sp = rand(8, 18);
      f.vx = Math.cos(ang) * sp;
      f.vy = Math.sin(ang) * sp;
    } else {
      const steer = 4; // px/s^2 random steering
      f.vx += (Math.random() - 0.5) * steer * dt;
      f.vy += (Math.random() - 0.5) * steer * dt;
      const max = 20; // cap speed
      const s = Math.hypot(f.vx, f.vy) || 1;
      if (s > max) { f.vx = f.vx / s * max; f.vy = f.vy / s * max; }
    }
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
    console.log('Player connected:', socket.id);

    // Initialize new player
    socket.on('player:join', (username: string) => {
        // Validate and sanitize username (max 20 characters for in-game names)
        const sanitizedUsername = (username || 'Player').trim().slice(0, 20);

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
            const maxDist = SELF_SPEED * dt * SPEED_TOL;
            let nx = clampedX, ny = clampedY;
            if (dist > maxDist) {
                const k = maxDist / (dist || 1);
                nx = prev.x + dx * k;
                ny = prev.y + dy * k;
            }

            // Check if new position would collide with any other shark
            // If so, block the movement (sharks are solid objects)
            if (sharkMask) {
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

        // Latency probe
        socket.on('client:ping', (t0: number) => { socket.emit('server:pong', t0); });

        }
    });

        // Client-reported eat request after client-side pixel-perfect collision check
        socket.on('player:eat', (foodId: number) => {
            const me = gameState.players[socket.id];
            const food = gameState.foods[Number(foodId)];
            if (!me || !food) return;


            // Coarse validation (distance) to prevent out-of-range requests
            const dx = (me.x + PLAYER_RADIUS) - food.x;
            const dy = (me.y + PLAYER_RADIUS) - food.y;
            const dist = Math.hypot(dx, dy);
            if (dist <= PLAYER_RADIUS + FOOD_RADIUS + 22 /* tolerance: increased to reduce false negatives */) {
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
    socket.on('disconnect', () => {
        console.log('Player disconnected:', socket.id);
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
                    // Deal damage
                    recordDamage(p.id, b.ownerId, BULLET_DAMAGE, now);
                    p.hp = Math.max(0, (p.hp ?? 100) - BULLET_DAMAGE);

                    // ALWAYS delete the bullet on contact, even if it's the killing blow
                    // DO NOT update position - delete immediately so client never sees it at collision point
                    delete bubbles[id];
                    projDirty = true;
                    dirty = true; // player state changed
                    hit = true;

                    // Handle death
                    if (p.hp <= 0) {
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

    // Players broadcast if state changed
    if (dirty) {
        dirty = false;
        io.volatile.compress(false).emit('players:update', { ts: Date.now(), players: gameState.players });
        // Server-side leaderboard (top 10 by score) — reliable emit (non-volatile)
        const lb = Object.values(gameState.players)
          .sort((a,b) => b.score - a.score)
          .slice(0, 10)
          .map(p => ({ id: p.id, username: p.username, score: p.score }));
        io.compress(false).emit('leaderboard:update', lb);
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
loadSharkEvolutions().catch(() => {});

setInterval(() => {
  if (!sharkMask || !foodMask) return;
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


// Use environment PORT for production (Render.com), fallback to 3000 for local dev
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
const HOST = process.env.HOST || '0.0.0.0';

httpServer.listen(PORT, HOST, () => {
    console.log(`🚀 Unified server (Static + Game) running on ${HOST}:${PORT}`);
    console.log(`📦 Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`🎮 Map size: ${MAP_SIZE}x${MAP_SIZE} pixels`);
    console.log(`✅ Static files, API, and Socket.IO game server ready!`);
});
