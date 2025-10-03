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
  if (!sharkMask || !foodMask) return false;
  // Coarse prune
  const cx = me.x + PLAYER_RADIUS, cy = me.y + PLAYER_RADIUS;
  const dx = cx - food.x, dy = cy - food.y;
  const maxR = PLAYER_RADIUS + FOOD_HALF + 16;
  if ((dx*dx + dy*dy) > (maxR*maxR)) return false;

  // Align with client visual: rotate(a+PI) then apply quadrant-based vertical flip
  const a = me.angle;
  let deg = (a * 180 / Math.PI) % 360; if (deg < 0) deg += 360;
  const flipY = (deg > 270 || deg < 90) ? -1 : 1;

  const rot = a + Math.PI;
  const cos = Math.cos(rot), sin = Math.sin(rot);

  // Iterate food pixels in local food space (dst size)
  for (let fy = 0; fy < FOOD_SIZE; fy++) {
    for (let fx = 0; fx < FOOD_SIZE; fx++) {
      if (foodMask[fy * FOOD_SIZE + fx] === 0) continue;
      const wx = food.x - FOOD_HALF + fx + 0.5;
      const wy = food.y - FOOD_HALF + fy + 0.5;
      const vx = wx - cx, vy = wy - cy;
      // rotate into shark-local (-rot) and apply flipY to match CSS scaleY on client
      const lx = vx * cos + vy * sin;
      const ly = (-vx * sin + vy * cos) * flipY;
      // Scale to mask space (mask is 256x256, shark renders at 171x171)
      const sx = Math.round((lx / SHARK_SCALE) + (SHARK_MASK_SIZE / 2));
      const sy = Math.round((ly / SHARK_SCALE) + (SHARK_MASK_SIZE / 2));
      if (sx < 0 || sy < 0 || sx >= SHARK_MASK_SIZE || sy >= SHARK_MASK_SIZE) continue;
      const idx = sy * SHARK_MASK_SIZE + sx;
      if (sharkMask[idx] !== 0) return true;
      // 5x5 kernel for better collision detection with scaled sprites
      for (let oy = -2; oy <= 2; oy++) {
        for (let ox = -2; ox <= 2; ox++) {
          const x = sx + ox, y = sy + oy;
          if (x < 0 || y < 0 || x >= SHARK_MASK_SIZE || y >= SHARK_MASK_SIZE) continue;
          if (sharkMask[y * SHARK_MASK_SIZE + x] !== 0) return true;
        }
      }
    }
  }
  return false;
}

function handleConsume(me: Player, food: Food) {
  delete gameState.foods[food.id];
  me.score = (me.score || 0) + 5;
  const newFood = spawnFoodDistributed();
  dirty = true;
  io.emit('food:respawn', { removedId: food.id, food: newFood });
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
        const users = await getUsers();
        if (users.find((u) => u.username === username)) { res.statusCode = 409; res.end('User exists'); return; }
        const user = { username: String(username), password: String(password), timeCreated: timeCreated || new Date().toISOString() };
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
        process.env.FRONTEND_URL || 'https://jawz.onrender.com',
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
  if (!sharkMask) return false;
  // Coarse prune by radius to avoid heavy math when far
  const cx = p.x + PLAYER_RADIUS, cy = p.y + PLAYER_RADIUS;
  const dx = bx - cx, dy = by - cy;
  const maxR = PLAYER_RADIUS + 8; // increased slack for better edge detection
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
  // Map to mask pixel coordinates (scale to mask space)
  const ux = Math.round((lx / SHARK_SCALE) + (SHARK_MASK_SIZE / 2));
  const uy = Math.round((ly / SHARK_SCALE) + (SHARK_MASK_SIZE / 2));
  if (ux < 0 || uy < 0 || ux >= SHARK_MASK_SIZE || uy >= SHARK_MASK_SIZE) return false;
  const idx = uy * SHARK_MASK_SIZE + ux;
  if (sharkMask[idx] !== 0) return true;

  // Enhanced 7x7 kernel for better collision detection with scaled sprites and moving bullets
  // This ensures we catch bullets that hit any colored pixel of the shark
  for (let oy = -3; oy <= 3; oy++) {
    for (let ox = -3; ox <= 3; ox++) {
      const x = ux + ox, y = uy + oy;
      if (x < 0 || y < 0 || x >= SHARK_MASK_SIZE || y >= SHARK_MASK_SIZE) continue;
      if (sharkMask[y * SHARK_MASK_SIZE + x] !== 0) return true;
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
    if (sharkMask[sy * SHARK_MASK_SIZE + sx] !== 0) return true;
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
        // Spawn players in the center area of the map (avoid borders for better camera view)
        usernames.set(socket.id, username);

        // Center spawn area: middle 60% of the map (20% margin from each edge)
        const spawnMargin = MAP_SIZE * 0.2;
        const spawnWidth = MAP_SIZE - (spawnMargin * 2) - SHARK_SIZE;
        const spawnHeight = MAP_SIZE - (spawnMargin * 2) - SHARK_SIZE;

        gameState.players[socket.id] = {
            id: socket.id,
            x: spawnMargin + Math.random() * spawnWidth,
            y: spawnMargin + Math.random() * spawnHeight,
            angle: 0,
            username,
            score: 0,
            hp: 100,
            dead: false,
        };

        console.log(`Player ${username} spawned at (${gameState.players[socket.id].x}, ${gameState.players[socket.id].y})`);

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
            const clampedX = Math.max(0, Math.min(MAP_SIZE - SHARK_SIZE, x));
            const clampedY = Math.max(0, Math.min(MAP_SIZE - SHARK_SIZE, y));

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
        // Note: MOUTH_OFFSET is in mask space, scale to render space
        const rot = me.angle + Math.PI;
        const cos = Math.cos(rot), sin = Math.sin(rot);
        const cx = me.x + PLAYER_RADIUS, cy = me.y + PLAYER_RADIUS;
        const mouthX = MOUTH_OFFSET_X * SHARK_SCALE; // Scale from mask to render space
        const mouthY = MOUTH_OFFSET_Y * SHARK_SCALE;
        const sx = cx + (mouthX * cos + mouthY * -sin);
        const sy = cy + (mouthX * sin + mouthY * cos);
        const dx = (tx - sx), dy = (ty - sy);
        const inv = 1 / (Math.hypot(dx, dy) || 1);
        const vx = dx * inv * BUBBLE_SPEED;
        const vy = dy * inv * BUBBLE_SPEED;
        const id = nextBubbleId++;
        bubbles[id] = { id, ownerId: socket.id, x: sx, y: sy, vx, vy, expireAt: now + BUBBLE_TTL_MS };
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

setInterval(() => {
  if (!sharkMask || !foodMask) return;
  const foodsArr = Object.values(gameState.foods);
  if (foodsArr.length === 0) return;
  for (const me of Object.values(gameState.players)) {
    const cx = me.x + PLAYER_RADIUS, cy = me.y + PLAYER_RADIUS;
    for (const food of foodsArr) {
      const dx = cx - food.x, dy = cy - food.y;
      const maxR = PLAYER_RADIUS + FOOD_HALF + 16;
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
