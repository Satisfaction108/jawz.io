import { Server } from 'socket.io';
import { createServer } from 'http';
import { promises as fsp } from 'fs';
import * as path from 'path';

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

interface Food { id: number; x: number; y: number; }

interface GameState {
    players: { [key: string]: Player };
    foods: { [key: number]: Food };
}

// Map configuration
const MAP_SIZE = 4000;
const PLAYER_RADIUS = 128; // matches client baby shark size (256px)
// Collision mask configuration
const SHARK_SIZE = 256; // baby shark sprite size (px)
const SHARK_HALF = SHARK_SIZE / 2;
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
let MOUTH_OFFSET_X = 26 - SHARK_HALF;  // fallback if mask not available
let MOUTH_OFFSET_Y = 150 - SHARK_HALF;

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
    const rawShark = parseBinaryMask(sharkTxt, SHARK_SIZE, SHARK_SIZE);
    sharkMask = rawShark;
    try {
      const mouth = computeMouthAnchorFromMask(sharkMask, SHARK_SIZE);
      MOUTH_OFFSET_X = mouth.x - SHARK_HALF;
      MOUTH_OFFSET_Y = mouth.y - SHARK_HALF;
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
      const sx = Math.round(lx + SHARK_HALF);
      const sy = Math.round(ly + SHARK_HALF);
      if (sx < 0 || sy < 0 || sx >= SHARK_SIZE || sy >= SHARK_SIZE) continue;
      const idx = sy * SHARK_SIZE + sx;
      if (sharkMask[idx] !== 0) return true;
      // Tiny cross kernel for robustness around rotation/rounding
      const offs = [[1,0],[-1,0],[0,1],[0,-1]] as const;
      for (const [ox, oy] of offs) {
        const x = sx + ox, y = sy + oy;
        if (x < 0 || y < 0 || x >= SHARK_SIZE || y >= SHARK_SIZE) continue;
        if (sharkMask[y * SHARK_SIZE + x] !== 0) return true;
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

const httpServer = createServer();
const io = new Server(httpServer, {
    cors: {
        origin: ["http://localhost:3000", "http://localhost:3001"],
        methods: ["GET", "POST"]
    }
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
    const food: Food = { id: nextFoodId++, x: best!.x, y: best!.y };
    gameState.foods[food.id] = food;
    return food;
}

function bubbleHitsShark(p: Player, bx: number, by: number): boolean {
  if (!sharkMask) return false;
  // Coarse prune by radius to avoid heavy math when far
  const cx = p.x + PLAYER_RADIUS, cy = p.y + PLAYER_RADIUS;
  const dx = bx - cx, dy = by - cy;
  const maxR = PLAYER_RADIUS + 2; // small slack
  if ((dx*dx + dy*dy) > (maxR*maxR)) return false;

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
  // Map to mask pixel coordinates
  const ux = Math.round(lx + SHARK_HALF);
  const uy = Math.round(ly + SHARK_HALF);
  if (ux < 0 || uy < 0 || ux >= SHARK_SIZE || uy >= SHARK_SIZE) return false;
  const idx = uy * SHARK_SIZE + ux;
  if (sharkMask[idx] !== 0) return true;
  // Sample a tiny cross kernel for robustness
  const offs = [[1,0],[-1,0],[0,1],[0,-1]] as const;
  for (const [ox, oy] of offs) {
    const x = ux + ox, y = uy + oy;
    if (x < 0 || y < 0 || x >= SHARK_SIZE || y >= SHARK_SIZE) continue;
    if (sharkMask[y * SHARK_SIZE + x] !== 0) return true;
  }
  return false;
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

io.on('connection', (socket) => {
    console.log('Player connected:', socket.id);

    // Initialize new player
    socket.on('player:join', (username: string) => {
        // Spawn players in the upper portion of the map (shallow water)
        usernames.set(socket.id, username);

        gameState.players[socket.id] = {
            id: socket.id,
            x: Math.random() * (MAP_SIZE - SHARK_SIZE), // Spawn fully in-bounds (top-left position)
            y: Math.random() * Math.max(0, (MAP_SIZE * 0.3 - SHARK_SIZE)), // Top 30% band, fully in-bounds
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
        if (now - last < SHOOT_COOLDOWN_MS) return; // cooldown enforcement
        lastShotAt.set(socket.id, now);
        // Spawn bubble at mouth offset rotated by (angle + 180deg)
        const rot = me.angle + Math.PI;
        const cos = Math.cos(rot), sin = Math.sin(rot);
        const cx = me.x + PLAYER_RADIUS, cy = me.y + PLAYER_RADIUS;
        const sx = cx + (MOUTH_OFFSET_X * cos + MOUTH_OFFSET_Y * -sin);
        const sy = cy + (MOUTH_OFFSET_X * sin + MOUTH_OFFSET_Y * cos);
        const dx = (tx - sx), dy = (ty - sy);
        const inv = 1 / (Math.hypot(dx, dy) || 1);
        const vx = dx * inv * BUBBLE_SPEED;
        const vy = dy * inv * BUBBLE_SPEED;
        const id = nextBubbleId++;
        bubbles[id] = { id, ownerId: socket.id, x: sx, y: sy, vx, vy, expireAt: now + BUBBLE_TTL_MS };
    });

    // Player respawn request (after death)
    socket.on('player:respawn', () => {
        let me = gameState.players[socket.id];
        if (me) return; // already alive
        const username = usernames.get(socket.id) || 'Player';
        me = gameState.players[socket.id] = {
            id: socket.id,
            x: Math.random() * (MAP_SIZE - SHARK_SIZE),
            y: Math.random() * Math.max(0, (MAP_SIZE * 0.3 - SHARK_SIZE)),
            angle: 0,
            username,
            score: 0,
            hp: 100,
            dead: false,
        } as Player;
        lastUpdate.set(socket.id, Date.now());
        lastPos.set(socket.id, { x: me.x, y: me.y });
        lastShotAt.set(socket.id, 0);
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
        b.x += b.vx * dt;
        b.y += b.vy * dt;
        // Despawn if hit map boundaries
        if (b.x < 0 || b.y < 0 || b.x > MAP_SIZE || b.y > MAP_SIZE) { delete bubbles[id]; projDirty = true; continue; }
        // Collision with players (exclude owner and dead targets)
        let hit = false;
        for (const p of Object.values(gameState.players)) {
            if (!p || p.id === b.ownerId || p.dead) continue;
            if (bubbleHitsShark(p, b.x, b.y)) {
                // Deal damage and despawn
                p.hp = Math.max(0, (p.hp ?? 100) - 5);
                if (p.hp <= 0) {
                    const dyingId = p.id;
                    const s = io.sockets.sockets.get(dyingId);
                    s?.emit('player:died');
                    // Remove this player's active bubbles and cooldown/state
                    for (const bid of Object.keys(bubbles)) {
                        if (bubbles[Number(bid)]?.ownerId === dyingId) { delete bubbles[Number(bid)]; projDirty = true; }
                    }
                    lastShotAt.delete(dyingId);
                    lastUpdate.delete(dyingId);
                    lastPos.delete(dyingId);
                    delete gameState.players[dyingId];
                    dirty = true;
                    io.emit('player:left', dyingId);
                }
                delete bubbles[id];
                projDirty = true;
                dirty = true; // player state changed
                hit = true;
                break;
            }
        }
        if (!hit && bubbles[id]) {
            updates.push({ id, x: b.x, y: b.y });
        }
    }

    // Emit projectiles to all clients; if there were removals but no movers, send empty to clear stale
    if (updates.length > 0 || projDirty) {
      io.volatile.compress(false).emit('projectiles:update', updates);
      projDirty = false;
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


const PORT = 3002;
httpServer.listen(PORT, () => {
    console.log(`Game server running on port ${PORT}`);
    console.log(`Map size: ${MAP_SIZE}x${MAP_SIZE} pixels`);
});
