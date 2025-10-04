"use strict";
const MAP_SIZE = 4000;
const SELF_SPEED = 495; // px/s (1.5x boost)
const SHARK_SIZE = Math.round(256 * (2 / 3)); // px (2/3 of original 256px = ~171px)
const SHARK_HALF = SHARK_SIZE / 2;
const SHARK_MASK_SIZE = 256; // Original mask size (masks are still 256x256)
const SHARK_SCALE = SHARK_SIZE / SHARK_MASK_SIZE; // Base scale (2/3)
const CAMERA_ZOOM = 0.8; // wider FOV (1.0 = no zoom)
// Visual constants
const BUBBLE_SIZE = 50; // base reference for gameplay-related sizes
const DECOR_BUBBLE_SIZE = 80; // px, explicit decorative bubble size as requested
const FISHFOOD_SIZE = Math.round(50 * 0.75); // keep food size stable (decoupled from decorative bubble size)
const FOOD_RADIUS = FISHFOOD_SIZE / 2;
let socket = null;
let players = {};
let topScore = 0; // highest score on server (from leaderboard)
let levelSteps = []; // XP needed to go from level L to L+1, zero-based index (0 => 1->2)
let levelsReady = false;
let selfId = null;
let myUsername = 'Player'; // Store username for respawn
let world;
let gameEl;
let landingEl;
let scoreFill;
let scoreText;
let levelFill;
let levelText;
let projectileLayer;
let projectiles = {};
let deathOverlay;
let btnRespawn;
let btnHome;
let deathScoreEl;
let deathLevelEl;
let deathTimeEl;
let sessionStartMs = 0;
// --- FX toggles (modular, easy to turn on/off) - optimized for performance ---
const FX = {
    damageShake: true,
    redVignette: true,
    criticalBlur: true,
    waterRipples: true,
    impactFlash: true,
    waterTrail: true, // Throttled to reduce DOM creation
    scorePopup: true,
};
// Performance: limit concurrent effect elements
const MAX_RIPPLES = 8;
const MAX_TRAIL_BUBBLES = 12;
const MAX_SCORE_POPUPS = 6;
let activeRipples = 0;
let activeTrailBubbles = 0;
let activeScorePopups = 0;
// Track active score popups for position updates
const activeScorePopupEls = [];
// Track which players have had death animation triggered
const deathAnimTriggered = new Set();
// FX state and helpers
let fxVignetteEl;
let fxCriticalEl;
let shakeMag = 0; // pixels of max jitter, decays per frame
const lastHpById = new Map();
const lastTrailTimeById = new Map();
const lastPosById = new Map();
let lastScoreSelf = 0;
function addScreenShake(intensity) {
    if (!FX.damageShake)
        return;
    shakeMag = Math.min(12, shakeMag + Math.max(0, intensity));
}
function pulseVignette() {
    if (!FX.redVignette || !fxVignetteEl)
        return;
    fxVignetteEl.classList.add('active');
    setTimeout(() => fxVignetteEl.classList.remove('active'), 220);
}
function updateCriticalOverlay(curHp) {
    if (!fxCriticalEl)
        return;
    if (FX.criticalBlur && curHp <= 20)
        fxCriticalEl.classList.add('active');
    else
        fxCriticalEl.classList.remove('active');
}
function spawnRipple(x, y, size = 37) {
    if (!FX.waterRipples || activeRipples >= MAX_RIPPLES)
        return;
    activeRipples++;
    const el = document.createElement('div');
    el.className = 'ripple';
    el.style.width = `${size}px`;
    el.style.height = `${size}px`;
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    world.appendChild(el);
    setTimeout(() => { el.remove(); activeRipples--; }, 450);
}
function markSharkHit(id) {
    if (!FX.impactFlash)
        return;
    const el = document.getElementById(`p-${id}`);
    if (!el)
        return;
    el.classList.add('shark--hit');
    setTimeout(() => el.classList.remove('shark--hit'), 140);
}
function spawnTrailBubbleAt(x, y, angle, sharkType) {
    if (!FX.waterTrail || activeTrailBubbles >= MAX_TRAIL_BUBBLES)
        return;
    // Always spawn exactly 1 bubble from the exact center of the tail
    const numBubbles = 1;
    for (let i = 0; i < numBubbles; i++) {
        if (activeTrailBubbles >= MAX_TRAIL_BUBBLES)
            break;
        activeTrailBubbles++;
        const el = document.createElement('div');
        el.className = 'trail-bubble';
        // Compute world-space tail point by rotating a sprite-local point on the tail edge around sprite center
        const rot = angle + Math.PI; // matches sprite rotate offset
        const cos = Math.cos(rot), sin = Math.sin(rot);
        const key = sharkType || 'Baby Shark.png';
        const s = sharkScales.get(key) || 1;
        let lx = SHARK_HALF, ly = SHARK_HALF; // default: center (in render space)
        // Account for horizontal flip when shark is facing right
        let deg = (angle * 180 / Math.PI) % 360;
        if (deg < 0)
            deg += 360;
        const flipY = (deg > 270 || deg < 90) ? -1 : 1; // right-facing quadrants => flip
        // Use shark-specific tail offset if available (from server)
        const tailOffset = sharkTailOffsets.get(key);
        if (tailOffset) {
            // Server provides tail offset in mask space relative to center (128, 128)
            // Convert to render space: add to center (128) then scale by base and visual scale
            // Apply flip to Y offset
            lx = (128 + tailOffset.x) * SHARK_SCALE * s;
            ly = (128 + tailOffset.y * flipY) * SHARK_SCALE * s;
        }
        else if (tailEdge && tailEdge.length) {
            // Fallback: use the median point along the tail edge as the center
            const mid = tailEdge[Math.floor(tailEdge.length / 2)];
            lx = mid.x * SHARK_SCALE * s;
            ly = mid.y * SHARK_SCALE * s * flipY; // Apply flip
        }
        else if (tailAnchor) {
            // Fallback: use computed tail anchor from baby shark alpha
            lx = tailAnchor.x * SHARK_SCALE * s;
            ly = tailAnchor.y * SHARK_SCALE * s * flipY; // Apply flip
        }
        const dx = lx - SHARK_HALF * s;
        const dy = ly - SHARK_HALF * s;
        const ax = x + SHARK_HALF * s + (dx * cos - dy * sin);
        const ay = y + SHARK_HALF * s + (dx * sin + dy * cos);
        // Emit slightly behind the facing direction from the exact tail center (no sideways spread)
        const baseOff = 6 * s; // scale with shark size
        const fx = Math.cos(angle), fy = Math.sin(angle);
        const bx = ax - fx * baseOff;
        const by = ay - fy * baseOff;
        // Use CSS variables consumed by the animation so transform isn't overridden
        // Trail bubble is 16px, so offset by half (8px) - scaled to 2/3 = ~11px, offset by ~5px
        el.style.setProperty('--x', `${Math.round(bx - 5)}px`); // 2/3 of 8px offset
        el.style.setProperty('--y', `${Math.round(by - 5)}px`);
        world.appendChild(el);
        setTimeout(() => { el.remove(); activeTrailBubbles--; }, 900);
    }
}
// Spawn evolution smoke particle explosion (Brawl Stars style)
function spawnEvolutionSmoke(x, y, s = 1) {
    const centerX = x + SHARK_HALF * s;
    const centerY = y + SHARK_HALF * s;
    // Central veil: blankets the shark to hide sprite swap
    const veil = document.createElement('div');
    veil.className = 'evolution-smoke-veil';
    const veilSize = Math.round(SHARK_SIZE * 1.35 * s);
    veil.style.width = `${veilSize}px`;
    veil.style.height = `${veilSize}px`;
    veil.style.left = `${centerX - veilSize / 2}px`;
    veil.style.top = `${centerY - veilSize / 2}px`;
    world.appendChild(veil);
    setTimeout(() => veil.remove(), 600);
    // Radial particles
    const numParticles = 16; // fuller burst
    for (let i = 0; i < numParticles; i++) {
        const particle = document.createElement('div');
        particle.className = 'evolution-smoke';
        // Random angle for radial spread
        const angle = (Math.PI * 2 * i) / numParticles + (Math.random() - 0.5) * 0.4;
        const speed = 42 + Math.random() * 34; // ~42-76px spread
        const offsetX = Math.cos(angle) * speed;
        const offsetY = Math.sin(angle) * speed;
        // Random size variation
        const size = (18 + Math.random() * 18) * (0.85 + 0.15 * s); // scale subtly with size
        particle.style.width = `${size}px`;
        particle.style.height = `${size}px`;
        // Set initial position at shark center
        particle.style.left = `${centerX - size / 2}px`;
        particle.style.top = `${centerY - size / 2}px`;
        // Use CSS variables for animation
        particle.style.setProperty('--offset-x', `${offsetX}px`);
        particle.style.setProperty('--offset-y', `${offsetY}px`);
        particle.style.setProperty('--rotation', `${Math.random() * 360}deg`);
        world.appendChild(particle);
        // Remove after animation completes
        setTimeout(() => particle.remove(), 750);
    }
}
function spawnScorePopup(playerId, delta) {
    if (!FX.scorePopup || activeScorePopups >= MAX_SCORE_POPUPS || !selfId)
        return;
    activeScorePopups++;
    const el = document.createElement('div');
    el.className = 'score-popup';
    el.textContent = `+${delta}`;
    // Initial position will be updated in render loop
    const p = players[playerId];
    if (p) {
        el.style.left = `${p.x + SHARK_HALF}px`;
        el.style.top = `${p.y - 27}px`; // 2/3 of -40px = ~-27px
    }
    world.appendChild(el);
    // Track this popup for position updates
    const popupData = { el, playerId, startTime: performance.now() };
    activeScorePopupEls.push(popupData);
    setTimeout(() => {
        el.remove();
        activeScorePopups--;
        // Remove from tracking array
        const idx = activeScorePopupEls.indexOf(popupData);
        if (idx !== -1)
            activeScorePopupEls.splice(idx, 1);
    }, 800);
}
// Spawn death particles and trigger death animation
function triggerDeathAnimation(playerId) {
    const p = players[playerId];
    if (!p)
        return;
    const el = document.getElementById(`p-${playerId}`);
    if (!el)
        return;
    // Set CSS variables for death animation (capture current position)
    el.style.setProperty('--death-x', `${Math.round(p.x)}px`);
    el.style.setProperty('--death-y', `${Math.round(p.y)}px`);
    const imgEl = el.querySelector('.shark__img');
    if (imgEl) {
        const currentTransform = imgEl.style.transform || '';
        const angleMatch = currentTransform.match(/rotate\(([^)]+)\)/);
        const flipMatch = currentTransform.match(/scaleY\(([^)]+)\)/);
        const angle = angleMatch ? angleMatch[1] : '0rad';
        const flip = flipMatch ? flipMatch[1] : '1';
        el.style.setProperty('--death-angle', angle);
        el.style.setProperty('--death-flip', flip);
    }
    // Spawn death particles (12 particles in random directions)
    const cx = p.x + SHARK_HALF;
    const cy = p.y + SHARK_HALF;
    for (let i = 0; i < 12; i++) {
        const particle = document.createElement('div');
        particle.className = 'death-particle';
        const angle = (i / 12) * Math.PI * 2 + (Math.random() - 0.5) * 0.5;
        const dist = 40 + Math.random() * 53; // 2/3 of (60 + 80) = 40 + 53
        const px = Math.cos(angle) * dist;
        const py = Math.sin(angle) * dist;
        particle.style.setProperty('--px', `${px}px`);
        particle.style.setProperty('--py', `${py}px`);
        particle.style.left = `${cx}px`;
        particle.style.top = `${cy}px`;
        world.appendChild(particle);
        setTimeout(() => particle.remove(), 1000);
    }
    // Large ripple effect at death location (2/3 of 120px = 80px)
    spawnRipple(Math.round(cx), Math.round(cy), 80);
    // Note: Shark element will be removed by server's 'player:left' event after 1.2s
    // This matches the death animation duration
}
function screenToWorld(cx, cy) {
    return { x: (cx - camera.x) / CAMERA_ZOOM, y: (cy - camera.y) / CAMERA_ZOOM };
}
function emitShootAtClientCoords(cx, cy) {
    if (!socket)
        return;
    const w = screenToWorld(cx, cy);
    socket.emit('player:shoot', { tx: w.x, ty: w.y });
}
// Hold-to-fire support with client-side throttle aligned to server cooldown
let fireHeld = false;
let fireTimer = null;
let lastClientShotAt = 0;
const CLIENT_COOLDOWN_MS = 500;
function aimCoords() {
    const m = mouse || { x: window.innerWidth / 2, y: window.innerHeight / 2 };
    return { cx: m.x, cy: m.y };
}
function tryFireOnce() {
    const now = performance.now();
    const timeSinceLastShot = now - lastClientShotAt;
    // Enforce client-side cooldown with small tolerance
    if (timeSinceLastShot < CLIENT_COOLDOWN_MS - 20) {
        // console.log(`Client cooldown: ${timeSinceLastShot.toFixed(0)}ms < ${CLIENT_COOLDOWN_MS}ms`);
        return;
    }
    lastClientShotAt = now;
    const { cx, cy } = aimCoords();
    emitShootAtClientCoords(cx, cy);
}
function startHoldFire() {
    if (fireHeld)
        return;
    fireHeld = true;
    tryFireOnce(); // Fire immediately
    // Use requestAnimationFrame loop instead of setInterval for more precise timing
    if (fireTimer !== null) {
        cancelAnimationFrame(fireTimer);
    }
    const fireLoop = () => {
        if (!fireHeld)
            return;
        tryFireOnce();
        fireTimer = requestAnimationFrame(fireLoop);
    };
    fireTimer = requestAnimationFrame(fireLoop);
}
function stopHoldFire() {
    fireHeld = false;
    if (fireTimer !== null) {
        cancelAnimationFrame(fireTimer);
        fireTimer = null;
    }
}
// Projectiles rendering (bubbles)
const PROJ_W = 34, PROJ_H = 32;
function updateProjectiles(updates) {
    if (!projectileLayer)
        return;
    const seen = new Set();
    for (const u of updates) {
        seen.add(u.id);
        let el = document.getElementById(`proj-${u.id}`);
        if (!el) {
            el = document.createElement('div');
            el.id = `proj-${u.id}`;
            el.className = 'projectile';
            projectileLayer.appendChild(el);
        }
        else {
            el.classList.remove('out');
        }
        const x = Math.round(u.x - PROJ_W / 2);
        const y = Math.round(u.y - PROJ_H / 2);
        el.style.transform = `translate3d(${x}px, ${y}px, 0)`;
        // Track last known world position for impact ripples
        projectiles[u.id] = { x: u.x, y: u.y };
    }
    const children = Array.from(projectileLayer.children);
    for (const el of children) {
        const idStr = el.id.startsWith('proj-') ? el.id.slice(5) : '';
        const id = Number(idStr);
        if (!seen.has(id)) {
            if (!el.classList.contains('out')) {
                const pos = projectiles[id];
                if (pos)
                    spawnRipple(Math.round(pos.x), Math.round(pos.y), 28); // 2/3 of 42px = 28px
                // Remove bullet instantly on contact (no fade delay)
                el.remove();
            }
            delete projectiles[id];
        }
    }
}
let bubbleLayer;
let posXEl;
let posYEl;
let minimap;
let ctx;
let lastFrame = performance.now();
let mouse = null;
let lastMinimapMs = 0;
let lastEatCheckMs = 0;
let camera = { x: -MAP_SIZE / 2, y: -MAP_SIZE / 2 };
// Performance + UI refs
let fpsEMA = 0;
let msEMA = 0;
let fpsEl;
let msEl;
let lbEl;
let lbHTMLCache = "";
let cameraTicker = null;
const SELF_POS_LOG_CAP = 5000;
const selfPosLog = new Array(SELF_POS_LOG_CAP);
let selfPosLogIdx = 0;
function startCameraTicker() {
    // Disabled ultra-high-frequency ticker to avoid CPU spikes; camera is updated in render()
    if (cameraTicker !== null) {
        clearInterval(cameraTicker);
        cameraTicker = null;
    }
}
// Game entities
let pingTimer = null;
let foods = {};
// Temporary bite animation window per player id
const biteUntil = new Map();
const foodEls = new Map();
let throttleAt = 0;
// Keyboard state for WASD movement
let keys = { w: false, a: false, s: false, d: false };
// Pixel-perfect collision assets and helpers
let imagesReady = false;
let sharkAlpha = null;
let foodAlpha = null;
let foodAlphaSize = FISHFOOD_SIZE; // width/height of pre-rendered food alpha map
// Tail anchor (in sprite local coordinates, origin = top-left of 256x256)
let tailAnchor = null;
// Tail offsets per shark type (from server, in mask space relative to center)
const sharkTailOffsets = new Map();
// Visual scale per shark type (from server)
const sharkScales = new Map();
// Evolution visual hold: delay sprite swap until smoke covers shark
const evolutionPrevSharkType = new Map();
const evolutionHoldUntil = new Map();
function computeTailAnchorFromAlpha(alpha, size) {
    const A = (x, y) => alpha[(y * size + x) * 4 + 3];
    let maxX = -1;
    const rightmost = new Array(size).fill(-1);
    for (let y = 0; y < size; y++) {
        for (let x = size - 1; x >= 0; x--) {
            if (A(x, y) > 10) {
                rightmost[y] = x;
                if (x > maxX)
                    maxX = x;
                break;
            }
        }
    }
    if (maxX < 0)
        return { x: Math.round(size * 0.85), y: Math.round(size / 2) };
    // Average y among rows that hit near the extreme right (within 2px) to find tail midline
    let sumY = 0, cnt = 0;
    for (let y = 0; y < size; y++) {
        if (rightmost[y] >= maxX - 2) {
            sumY += y;
            cnt++;
        }
    }
    const yMid = cnt ? Math.round(sumY / cnt) : Math.round(size / 2);
    return { x: maxX, y: yMid };
}
// Densely sample the rightmost opaque edge rows to represent the tail surface
let tailEdge = null;
function computeTailEdgeFromAlpha(alpha, size) {
    const A = (x, y) => alpha[(y * size + x) * 4 + 3];
    let maxX = -1;
    const rightmost = new Array(size).fill(-1);
    for (let y = 0; y < size; y++) {
        for (let x = size - 1; x >= 0; x--) {
            if (A(x, y) > 10) {
                rightmost[y] = x;
                if (x > maxX)
                    maxX = x;
                break;
            }
        }
    }
    const pts = [];
    if (maxX >= 0) {
        for (let y = 0; y < size; y++) {
            const rx = rightmost[y];
            if (rx >= maxX - 2 && rx >= 0)
                pts.push({ x: rx, y });
        }
    }
    // Thin out to reduce overdraw while keeping good coverage
    if (pts.length > 60) {
        const thin = [];
        const step = Math.max(1, Math.floor(pts.length / 40));
        for (let i = 0; i < pts.length; i += step)
            thin.push(pts[i]);
        return thin;
    }
    return pts;
}
function loadCollisionMaps() {
    return new Promise((resolve) => {
        let loaded = 0;
        const done = () => { if (++loaded === 2) {
            imagesReady = true;
            resolve();
        } };
        // Shark (256x256). Prefer provided binary text mask; fallback to legacy masks or image alpha
        (async () => {
            const tryPaths = [
                '/sharks/baby%20shark.txt', // exact provided file
                '/sharks/Baby%20Shark.mask.txt', // legacy optional
                '/sharks/baby-shark-mask.txt' // legacy optional
            ];
            let usedMask = false;
            for (const p of tryPaths) {
                try {
                    const res = await fetch(p);
                    if (res.ok) {
                        const txt = await res.text();
                        const s = SHARK_MASK_SIZE; // Use mask size (256), not render size
                        // Strip everything except 0/1 and newlines, then flatten
                        const flat = txt.replace(/[^01\n]/g, '').replace(/\n+/g, '');
                        if (flat.length >= s * s) {
                            const data = new Uint8ClampedArray(s * s * 4);
                            for (let i = 0; i < s * s; i++) {
                                const v = flat.charCodeAt(i) === 49 /* '1' */ ? 255 : 0;
                                const off = i * 4;
                                data[off] = 0;
                                data[off + 1] = 0;
                                data[off + 2] = 0;
                                data[off + 3] = v;
                            }
                            sharkAlpha = data;
                            // Compute tail anchor + edge from mask (sprite is left-facing by default; tail is the rightmost opaque edge)
                            tailAnchor = computeTailAnchorFromAlpha(sharkAlpha, SHARK_MASK_SIZE);
                            tailEdge = computeTailEdgeFromAlpha(sharkAlpha, SHARK_MASK_SIZE);
                            usedMask = true;
                            break;
                        }
                    }
                }
                catch { }
            }
            if (!usedMask) {
                const sharkImg = new Image();
                sharkImg.src = '/sharks/Baby%20Shark.png';
                sharkImg.onload = () => {
                    // Use SHARK_MASK_SIZE (256) for collision detection, not render size
                    const c = document.createElement('canvas');
                    c.width = SHARK_MASK_SIZE;
                    c.height = SHARK_MASK_SIZE;
                    const cctx = c.getContext('2d');
                    cctx.clearRect(0, 0, SHARK_MASK_SIZE, SHARK_MASK_SIZE);
                    const nw = sharkImg.naturalWidth || sharkImg.width;
                    const nh = sharkImg.naturalHeight || sharkImg.height;
                    const scale = Math.max(SHARK_MASK_SIZE / nw, SHARK_MASK_SIZE / nh); // cover
                    const dw = nw * scale, dh = nh * scale;
                    const dx = (SHARK_MASK_SIZE - dw) / 2, dy = (SHARK_MASK_SIZE - dh) / 2; // centered
                    cctx.drawImage(sharkImg, dx, dy, dw, dh);
                    sharkAlpha = cctx.getImageData(0, 0, SHARK_MASK_SIZE, SHARK_MASK_SIZE).data; // RGBA
                    // Compute tail anchor + edge from image alpha if text mask not provided
                    tailAnchor = computeTailAnchorFromAlpha(sharkAlpha, SHARK_MASK_SIZE);
                    tailEdge = computeTailEdgeFromAlpha(sharkAlpha, SHARK_MASK_SIZE);
                    done();
                };
                return; // wait for onload -> done()
            }
            // Mask path succeeded
            done();
        })();
        // Food alpha: read provided 64x64 binary mask and resample to render size
        (async () => {
            const target = FISHFOOD_SIZE;
            let ok = false;
            try {
                const res = await fetch('/food/FishFood.txt');
                if (res.ok) {
                    const txt = await res.text();
                    const flat = txt.replace(/[^01\n]/g, '').replace(/\n+/g, '');
                    const srcW = 64, srcH = 64;
                    if (flat.length >= srcW * srcH) {
                        const srcCanvas = document.createElement('canvas');
                        srcCanvas.width = srcW;
                        srcCanvas.height = srcH;
                        const sctx = srcCanvas.getContext('2d');
                        const img = sctx.createImageData(srcW, srcH);
                        for (let i = 0; i < srcW * srcH; i++) {
                            const v = flat.charCodeAt(i) === 49 /* '1' */ ? 255 : 0;
                            const off = i * 4;
                            img.data[off] = 0;
                            img.data[off + 1] = 0;
                            img.data[off + 2] = 0;
                            img.data[off + 3] = v;
                        }
                        sctx.putImageData(img, 0, 0);
                        // Scale to target size
                        const dstCanvas = document.createElement('canvas');
                        dstCanvas.width = target;
                        dstCanvas.height = target;
                        const dctx = dstCanvas.getContext('2d');
                        dctx.clearRect(0, 0, target, target);
                        // Use nearest-neighbor like scaling for crisp mask
                        dctx.imageSmoothingEnabled = false;
                        dctx.drawImage(srcCanvas, 0, 0, target, target);
                        const id = dctx.getImageData(0, 0, target, target);
                        foodAlpha = id.data;
                        foodAlphaSize = target;
                        ok = true;
                    }
                }
            }
            catch { }
            if (!ok) {
                // Fallback: procedural circle
                const s = target;
                const c = document.createElement('canvas');
                c.width = s;
                c.height = s;
                const cctx = c.getContext('2d');
                cctx.clearRect(0, 0, s, s);
                cctx.beginPath();
                cctx.arc(s / 2, s / 2, s / 2, 0, Math.PI * 2);
                cctx.fillStyle = '#ffffff';
                cctx.fill();
                foodAlpha = cctx.getImageData(0, 0, s, s).data;
                foodAlphaSize = s;
            }
            done();
        })();
    });
}
// Per-food send throttle to avoid spamming yet allow rapid retries during movement
const lastEatEmit = new Map();
function requestEat(foodId) {
    if (!socket)
        return;
    const now = performance.now();
    const last = lastEatEmit.get(foodId) || 0;
    if (now - last < 70)
        return; // at most ~14 emits/sec per food while overlapping
    lastEatEmit.set(foodId, now);
    socket.volatile.emit('player:eat', foodId);
}
function pixelPerfectHit(me, food) {
    if (!imagesReady || !sharkAlpha || !foodAlpha)
        return false;
    // Quick circle check first (slightly more forgiving)
    const cx = me.x + SHARK_HALF, cy = me.y + SHARK_HALF;
    const dx = cx - food.x, dy = cy - food.y;
    const maxDist = SHARK_HALF + FOOD_RADIUS + 20; // increased tolerance
    if ((dx * dx + dy * dy) > (maxDist * maxDist))
        return false;
    const rot = me.angle + Math.PI;
    const cos = Math.cos(rot), sin = Math.sin(rot);
    const sSize = SHARK_MASK_SIZE; // Use mask size (256), not render size (171)
    const fSize = foodAlphaSize;
    const halfF = FOOD_RADIUS;
    const sampleShark = (sx, sy) => {
        if (sx < 0 || sy < 0 || sx >= sSize || sy >= sSize)
            return 0;
        const data = sharkAlpha;
        return data[(sy * sSize + sx) * 4 + 3];
    };
    // Iterate food opaque pixels and map into shark local space
    for (let fy = 0; fy < fSize; fy++) {
        for (let fx = 0; fx < fSize; fx++) {
            const fa = foodAlpha[(fy * fSize + fx) * 4 + 3];
            if (fa === 0)
                continue; // transparent food pixel
            // world position of this food pixel (treat each pixel center)
            const wx = food.x - halfF + fx + 0.5;
            const wy = food.y - halfF + fy + 0.5;
            // vector from shark center (in render space)
            const vx = wx - cx;
            const vy = wy - cy;
            // rotate by -rot: x' = x cos + y sin ; y' = -x sin + y cos
            const lx = vx * cos + vy * sin;
            const ly = -vx * sin + vy * cos;
            // Scale to mask space (mask is 256x256, shark renders at 171x171)
            const sx = Math.round((lx / SHARK_SCALE) + sSize / 2);
            const sy = Math.round((ly / SHARK_SCALE) + sSize / 2);
            // 5x5 neighborhood for better collision detection with scaled sprites
            for (let oy = -2; oy <= 2; oy++) {
                for (let ox = -2; ox <= 2; ox++) {
                    const sa = sampleShark(sx + ox, sy + oy);
                    if (sa !== 0)
                        return true; // colored pixel overlap
                }
            }
        }
    }
    return false;
}
function checkEatCollisions() {
    if (!socket || !selfId)
        return;
    const me = players[selfId];
    if (!me)
        return;
    for (const f of Object.values(foods)) {
        // coarse range filter
        const dx = (me.x + SHARK_HALF) - f.x;
        const dy = (me.y + SHARK_HALF) - f.y;
        const maxR = SHARK_HALF + FOOD_RADIUS + 16;
        if ((dx * dx + dy * dy) > (maxR * maxR))
            continue;
        if (pixelPerfectHit(me, f)) {
            requestEat(f.id);
        }
    }
}
// Auth/UI elements
let btnLogin;
let btnSignup;
let accountChip;
let accountName;
let accountMenu;
let menuLogout;
let menuReset;
// Modals and inputs
let modalSignup, suUser, suPass, suErrors, suCancel, suSubmit;
let modalLogin, liUser, liPass, liErrors, liCancel, liSubmit;
let modalReset, rpPass, rpConfirm, rpErrors, rpCancel, rpSubmit;
let modalProfile, profileClose;
let suStrengthFill, suStrengthText;
let rpStrengthFill, rpStrengthText;
let menuProfile;
const API_BASE = '';
function hashPassword(password) {
    return btoa(password + 'jawz_salt');
}
function validatePassword(password) {
    const errors = [];
    if (password.length < 6)
        errors.push('Password must be at least 6 characters');
    if (!/\d/.test(password))
        errors.push('Password must include at least 1 number');
    // Calculate strength
    let strength = 'weak';
    if (password.length >= 8 && /[A-Z]/.test(password) && /[a-z]/.test(password) && /\d/.test(password)) {
        strength = 'strong';
    }
    else if (password.length >= 6 && /\d/.test(password)) {
        strength = 'medium';
    }
    return { isValid: errors.length === 0, errors, strength };
}
function updatePasswordStrength(password, fillEl, textEl) {
    const result = validatePassword(password);
    // Remove all strength classes
    fillEl.classList.remove('weak', 'medium', 'strong');
    textEl.classList.remove('weak', 'medium', 'strong');
    if (password.length === 0) {
        fillEl.style.width = '0%';
        textEl.textContent = '';
        return;
    }
    // Add appropriate class
    fillEl.classList.add(result.strength);
    textEl.classList.add(result.strength);
    // Update text
    const strengthText = {
        weak: 'Weak',
        medium: 'Medium',
        strong: 'Strong'
    };
    textEl.textContent = strengthText[result.strength];
}
function getSession() {
    try {
        const s = localStorage.getItem('jawz_user');
        return s ? JSON.parse(s) : null;
    }
    catch {
        return null;
    }
}
function setSession(s) { localStorage.setItem('jawz_user', JSON.stringify(s)); }
function clearSession() { localStorage.removeItem('jawz_user'); }
function openModal(el) { el.classList.remove('hidden'); }
function closeModal(el) { el.classList.add('hidden'); }
function showLoading(text) {
    const overlay = document.getElementById('loading-overlay');
    const loadingText = document.getElementById('loading-text');
    if (overlay && loadingText) {
        loadingText.textContent = text;
        overlay.classList.remove('hidden');
    }
}
function hideLoading() {
    const overlay = document.getElementById('loading-overlay');
    if (overlay) {
        overlay.classList.add('hidden');
    }
}
async function signup(username, password) {
    const v = validatePassword(password);
    if (!v.isValid)
        return { ok: false, error: v.errors.join('\n') };
    const res = await fetch(`${API_BASE}/api/users`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password: hashPassword(password), timeCreated: new Date().toISOString() })
    });
    if (res.status === 409)
        return { ok: false, error: 'Username already exists' };
    if (!res.ok)
        return { ok: false, error: 'Sign up failed' };
    const data = await res.json();
    return { ok: true, data };
}
async function login(username, password) {
    const res = await fetch(`${API_BASE}/api/users`);
    if (!res.ok)
        return { ok: false, error: 'Login failed' };
    const users = await res.json();
    const found = users.find(u => u.username === username);
    if (!found)
        return { ok: false, error: 'User not found' };
    if (found.password !== hashPassword(password))
        return { ok: false, error: 'Invalid password' };
    return { ok: true, data: { username: found.username, timeCreated: found.timeCreated } };
}
async function resetPassword(newPassword) {
    const s = getSession();
    if (!s)
        return { ok: false, error: 'Not logged in' };
    const v = validatePassword(newPassword);
    if (!v.isValid)
        return { ok: false, error: v.errors.join('\n') };
    const res = await fetch(`${API_BASE}/api/users/${encodeURIComponent(s.username)}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: hashPassword(newPassword) })
    });
    if (!res.ok)
        return { ok: false, error: 'Update failed' };
    return { ok: true };
}
function setUIFromSession() {
    const s = getSession();
    if (s) {
        btnLogin.classList.add('hidden');
        btnSignup.classList.add('hidden');
        accountChip.classList.remove('hidden');
        accountName.textContent = s.username;
        // Prefill username input for single Play button flow
        const input = document.getElementById('username');
        if (input)
            input.value = s.username;
        // Ensure account menu closed
        accountChip.setAttribute('aria-expanded', 'false');
        if (accountMenu)
            accountMenu.classList.add('hidden');
    }
    else {
        btnLogin.classList.remove('hidden');
        btnSignup.classList.remove('hidden');
        accountChip.classList.add('hidden');
        accountName.textContent = '';
        accountChip.setAttribute('aria-expanded', 'false');
        if (accountMenu)
            accountMenu.classList.add('hidden');
        const input = document.getElementById('username');
        if (input)
            input.value = '';
    }
}
function createBubbleLayer(n = 12) {
    for (let i = 0; i < n; i++) {
        const b = document.createElement('img');
        b.className = 'bubble';
        b.src = '/props/bubble.png.png';
        b.alt = 'bubble';
        // Explicit dimensions both as CSS and HTML attributes to avoid runtime resampling
        b.width = DECOR_BUBBLE_SIZE;
        b.height = DECOR_BUBBLE_SIZE;
        b.style.width = `${DECOR_BUBBLE_SIZE}px`;
        b.style.height = `${DECOR_BUBBLE_SIZE}px`;
        b.style.left = `${Math.random() * 100}%`;
        b.style.bottom = `${-Math.random() * 30}vh`;
        // Negative delay to distribute bubbles immediately across the column
        b.style.animationDelay = `${(-Math.random() * 14).toFixed(2)}s`;
        bubbleLayer.appendChild(b);
    }
}
// Camera helpers: always keep the local player's shark centered on screen with border limits
function updateCameraToSelf() {
    if (!selfId)
        return;
    const self = players[selfId];
    if (!self)
        return;
    // Compute CSS-pixel offsets so the shark center is exactly at the viewport center
    const z = CAMERA_ZOOM;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    // Calculate desired camera position (centered on shark, respecting scale)
    const keySelf = self.sharkType || 'Baby Shark.png';
    const sSelf = sharkScales.get(keySelf) || 1;
    let cx = Math.round((vw / 2) - (self.x + SHARK_HALF * sSelf) * z);
    let cy = Math.round((vh / 2) - (self.y + SHARK_HALF * sSelf) * z);
    // Apply camera limits to prevent showing borders
    // The world is MAP_SIZE x MAP_SIZE, scaled by CAMERA_ZOOM
    const worldWidth = MAP_SIZE * z;
    const worldHeight = MAP_SIZE * z;
    // Clamp camera so borders are never visible
    // Camera position represents the top-left corner of the world in screen space
    // Right edge: camera.x + worldWidth >= vw (world's right edge must be at or past screen right)
    // Bottom edge: camera.y + worldHeight >= vh (world's bottom edge must be at or past screen bottom)
    const minX = vw - worldWidth; // Most negative (left) the camera can go
    const maxX = 0; // Most positive (right) the camera can go
    const minY = vh - worldHeight; // Most negative (top) the camera can go
    const maxY = 0; // Most positive (bottom) the camera can go
    // Only apply limits if the world is larger than the viewport
    if (worldWidth > vw) {
        cx = Math.max(minX, Math.min(maxX, cx));
    }
    if (worldHeight > vh) {
        cy = Math.max(minY, Math.min(maxY, cy));
    }
    camera.x = cx;
    camera.y = cy;
}
function applyCameraTransform() {
    // Apply the camera transform to move the world with origin at (0,0)
    // Scale first (rightmost), then translate in CSS pixels
    // Screen shake offset (lightweight, decays every frame)
    const sx = shakeMag ? (Math.random() * 2 - 1) * shakeMag : 0;
    const sy = shakeMag ? (Math.random() * 2 - 1) * shakeMag : 0;
    shakeMag *= 0.90;
    world.style.transform = `translate3d(${Math.round(camera.x + sx)}px, ${Math.round(camera.y + sy)}px, 0) scale(${CAMERA_ZOOM})`;
}
function ensureSharkEl(id, username) {
    let el = document.getElementById(`p-${id}`);
    if (!el) {
        el = document.createElement('div');
        el.id = `p-${id}`;
        el.className = 'shark';
        const glow = document.createElement('div');
        glow.className = 'shark__glow';
        const img = document.createElement('div');
        img.className = 'shark__img';
        // Don't set background image here - it will be set dynamically in render loop
        const flash = document.createElement('div');
        flash.className = 'shark__flash';
        const name = document.createElement('div');
        name.className = 'shark__name';
        name.textContent = username;
        const hp = document.createElement('div');
        hp.className = 'shark__hp';
        hp.innerHTML = '<div class="shark__hpTrack"><div class="shark__hpFill" style="width:100%"></div></div>';
        el.appendChild(glow);
        el.appendChild(img);
        el.appendChild(flash);
        el.appendChild(name);
        el.appendChild(hp);
        world.appendChild(el);
    }
    return el;
}
function ensureFoodEl(food) {
    let el = document.getElementById(`f-${food.id}`);
    if (!el) {
        el = document.createElement('div');
        el.id = `f-${food.id}`;
        el.className = 'food';
        el.style.width = `${FISHFOOD_SIZE}px`;
        el.style.height = `${FISHFOOD_SIZE}px`;
        world.appendChild(el);
    }
    el.style.transform = `translate(${Math.round(food.x - FISHFOOD_SIZE / 2)}px, ${Math.round(food.y - FISHFOOD_SIZE / 2)}px)`;
    foodEls.set(food.id, el);
    return el;
}
function removeFoodEl(id) {
    const el = document.getElementById(`f-${id}`);
    if (el && el.parentElement)
        el.parentElement.removeChild(el);
    foodEls.delete(id);
}
function escapeHTML(s) { return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[c])); }
function updateLeaderboard(entries) {
    if (!lbEl)
        return;
    const html = entries.slice(0, 10).map((e, i) => (`<li class="leaderboard__item"><div class="leaderboard__rank">${i + 1}</div><div class="leaderboard__name">${escapeHTML(e.username)}</div><div class="leaderboard__score">${e.score}</div></li>`)).join('');
    const wrapped = `<ul class=\"leaderboard__list\">${html}</ul>`;
    if (wrapped !== lbHTMLCache) {
        lbHTMLCache = wrapped;
        lbEl.innerHTML = wrapped;
    }
}
function createBubbleLayerFromSeeds(seeds) {
    if (!bubbleLayer)
        return;
    bubbleLayer.innerHTML = '';
    for (const s of seeds) {
        const b = document.createElement('img');
        b.className = 'bubble';
        b.src = '/props/bubble.png.png';
        b.alt = 'bubble';
        // Explicit dimensions both as CSS and HTML attributes to avoid runtime resampling
        b.width = DECOR_BUBBLE_SIZE;
        b.height = DECOR_BUBBLE_SIZE;
        b.style.width = `${DECOR_BUBBLE_SIZE}px`;
        b.style.height = `${DECOR_BUBBLE_SIZE}px`;
        b.style.left = `${s.left}%`;
        b.style.bottom = `${-Math.random() * 30}vh`;
        b.style.animationDelay = `${s.delay.toFixed(2)}s`;
        bubbleLayer.appendChild(b);
    }
}
function removeSharkEl(id) {
    const el = document.getElementById(`p-${id}`);
    el?.parentElement?.removeChild(el);
    // Clean up death animation tracking
    deathAnimTriggered.delete(id);
}
function render() {
    // 1) Update camera so the self shark is at the exact screen center
    updateCameraToSelf();
    // 2) Apply camera transform to move the world (not the shark)
    applyCameraTransform();
    // 3) Place and orient all sharks in world space
    for (const p of Object.values(players)) {
        const el = ensureSharkEl(p.id, p.username);
        // Dead visual state - trigger death animation once
        if (p.dead) {
            el.classList.add('shark--dead');
            if (!deathAnimTriggered.has(p.id)) {
                deathAnimTriggered.add(p.id);
                triggerDeathAnimation(p.id);
            }
            // Skip position/rotation updates for dead sharks - let CSS animation handle it
            continue;
        }
        else {
            el.classList.remove('shark--dead');
            deathAnimTriggered.delete(p.id);
        }
        // Position and scale container (name/HP remain upright since rotation is on image only)
        const keyType = p.sharkType || 'Baby Shark.png';
        const s = sharkScales.get(keyType) || 1;
        el.style.transform = `translate3d(${Math.round(p.x)}px, ${Math.round(p.y)}px, 0) scale(${s})`;
        if (s >= 1.32)
            el.classList.add('shark--apex');
        else
            el.classList.remove('shark--apex');
        // Rotate/mirror only the shark image so the label remains upright and unflipped
        const a = p.angle;
        let deg = (a * 180 / Math.PI) % 360;
        if (deg < 0)
            deg += 360; // normalize 0..360
        const flipX = (deg > 270 || deg < 90) ? -1 : 1; // right-side quadrants => flip
        const imgEl = el.querySelector('.shark__img');
        const flashEl = el.querySelector('.shark__flash');
        const glowEl = el.querySelector('.shark__glow');
        if (imgEl) {
            // Update shark sprite based on sharkType, with optional evolution hold to let smoke cover swap
            let sharkType = p.sharkType || 'Baby Shark.png';
            const holdUntil = evolutionHoldUntil.get(p.id) || 0;
            const nowT = performance.now();
            if (nowT < holdUntil) {
                const prev = evolutionPrevSharkType.get(p.id);
                if (prev)
                    sharkType = prev;
            }
            else if (holdUntil) {
                // Clear hold after it expires
                evolutionHoldUntil.delete(p.id);
                evolutionPrevSharkType.delete(p.id);
            }
            const sharkPath = `/sharks/${encodeURIComponent(sharkType)}`;
            const expectedBg = `url("${sharkPath}")`;
            // Always update to ensure correct sprite (avoid comparison issues with URL encoding)
            imgEl.style.backgroundImage = expectedBg;
            // Also update flash and glow elements to use same sprite for effects
            if (flashEl)
                flashEl.style.backgroundImage = expectedBg;
            if (glowEl)
                glowEl.style.backgroundImage = expectedBg;
            const now = performance.now();
            const baseBite = (biteUntil.get(p.id) || 0) > now ? 1.08 : 1.0;
            const biteScale = baseBite + Math.max(0, s - 1) * 0.04; // slightly stronger bite puff for bigger sharks
            const tr = `rotate(${(a + Math.PI)}rad) scaleY(${flipX}) scale(${biteScale})`;
            imgEl.style.transform = tr;
            if (flashEl)
                flashEl.style.transform = tr;
            if (glowEl)
                glowEl.style.transform = tr;
        }
        // Health bar update
        const hpEl = el.querySelector('.shark__hpFill');
        if (hpEl) {
            const cur = Math.max(0, Math.min(100, p.hp ?? 100));
            hpEl.style.width = cur + '%';
            // Dynamic HP color thresholds
            if (cur < 25) {
                hpEl.style.background = 'linear-gradient(90deg, #ff6b6b, #ff5252)';
            }
            else if (cur < 50) {
                hpEl.style.background = 'linear-gradient(90deg, #ffd24a, #ffb02a)';
            }
            else {
                hpEl.style.background = 'linear-gradient(90deg, #2aff88, #14d06a)';
            }
        }
        // --- FX: damage detection, trail emission, critical overlay ---
        const curHp = Math.max(0, Math.min(100, p.hp ?? 100));
        const prevHp = lastHpById.get(p.id) ?? curHp;
        if (p.id === selfId)
            updateCriticalOverlay(curHp);
        if (curHp < prevHp) {
            markSharkHit(p.id);
            spawnRipple(Math.round(p.x + SHARK_HALF), Math.round(p.y + SHARK_HALF), 56);
            if (p.id === selfId) {
                addScreenShake(Math.min(10, (prevHp - curHp) * 0.25));
                pulseVignette();
            }
        }
        lastHpById.set(p.id, curHp);
        // Water trail: throttle more aggressively for performance (only when moving)
        const nowMs2 = performance.now();
        const lastT = lastTrailTimeById.get(p.id) || 0;
        const prevPos = lastPosById.get(p.id);
        // Increased throttle from 160ms to 250ms for better performance
        if (nowMs2 - lastT > 250 && prevPos && (Math.abs(prevPos.x - p.x) + Math.abs(prevPos.y - p.y) > 2)) {
            spawnTrailBubbleAt(p.x, p.y, p.angle, p.sharkType);
            lastTrailTimeById.set(p.id, nowMs2);
        }
        lastPosById.set(p.id, { x: p.x, y: p.y });
    }
    // 3.5) Update score popup positions to follow the shark
    for (const popup of activeScorePopupEls) {
        const p = players[popup.playerId];
        if (p) {
            // Position above the shark's head with a rising animation
            const elapsed = performance.now() - popup.startTime;
            const riseOffset = Math.min(33, elapsed * 0.053); // 2/3 of 50px and 0.08 speed
            popup.el.style.left = `${p.x + SHARK_HALF}px`;
            popup.el.style.top = `${p.y - 27 - riseOffset}px`; // 2/3 of -40px
        }
    }
    // 4) HUD updates for the local player
    if (selfId && players[selfId]) {
        const self = players[selfId];
        posXEl.textContent = String(Math.round(self.x));
        posYEl.textContent = String(Math.round(self.y));
        // Score bar: progress towards first place
        if (scoreText && scoreFill) {
            const s = self.score || 0;
            scoreText.textContent = String(s);
            let pct = 0;
            if (s >= topScore) {
                // If tied for first or first place (including the 0 vs 0 case), show 100%
                pct = 100;
            }
            else if (topScore > 0) {
                pct = Math.max(0, Math.min(100, (s / topScore) * 100));
            }
            scoreFill.style.width = pct + '%';
            // FX: score popup for local gains
            if (s > lastScoreSelf) {
                const delta = s - lastScoreSelf;
                spawnScorePopup(selfId, delta);
            }
            lastScoreSelf = s;
        }
        // Level bar: compute from progression steps (guard until levels are loaded)
        if (levelFill && levelText) {
            const s = self.score || 0;
            if (!levelsReady || levelSteps.length === 0) {
                levelFill.style.width = '0%';
                levelText.textContent = '1';
            }
            else {
                let lvl = 1;
                let remaining = s;
                for (let i = 0; i < levelSteps.length; i++) {
                    const need = levelSteps[i] | 0;
                    if (remaining >= need) {
                        remaining -= need;
                        lvl++;
                    }
                    else {
                        break;
                    }
                }
                const nextNeed = levelSteps[lvl - 1]; // index is level-1 for L->L+1
                let pct = 100;
                if (typeof nextNeed === 'number' && nextNeed > 0) {
                    pct = Math.max(0, Math.min(100, (remaining / nextNeed) * 100));
                }
                else if (lvl === 1) {
                    // Explicitly show empty when at level 1 with no data
                    pct = 0;
                }
                levelFill.style.width = pct + '%';
                levelText.textContent = String(lvl);
            }
        }
    }
    // Minimap - optimized to update less frequently (150ms instead of 100ms)
    if (ctx) {
        const t = performance.now();
        if (t - lastMinimapMs > 150) {
            lastMinimapMs = t;
            ctx.clearRect(0, 0, 200, 200);
            ctx.fillStyle = 'rgba(100,180,255,0.15)';
            ctx.fillRect(0, 0, 200, 200);
            for (const p of Object.values(players)) {
                const mx = (p.x / MAP_SIZE) * 200;
                const my = (p.y / MAP_SIZE) * 200;
                ctx.fillStyle = p.id === selfId ? '#ffe46b' : '#ff6b6b';
                ctx.beginPath();
                ctx.arc(mx, my, p.id === selfId ? 3 : 2, 0, Math.PI * 2);
                ctx.fill();
            }
        }
    }
}
function step(dt) {
    if (!selfId)
        return;
    const me = players[selfId];
    if (!me || me.dead)
        return;
    // Target velocity from WASD keys
    let vx = 0, vy = 0;
    let mx = 0, my = 0;
    if (keys.w)
        my -= 1;
    if (keys.s)
        my += 1;
    if (keys.a)
        mx -= 1;
    if (keys.d)
        mx += 1;
    if (mx !== 0 || my !== 0) {
        const invLen = 1 / Math.hypot(mx, my);
        mx *= invLen;
        my *= invLen;
        vx = mx * SELF_SPEED;
        vy = my * SELF_SPEED;
    }
    // Integrate position with smooth acceleration
    const ax = 12; // accel
    me.vx = (me.vx || 0) + (vx - (me.vx || 0)) * ax * dt;
    me.vy = (me.vy || 0) + (vy - (me.vy || 0)) * ax * dt;
    // Clamp to keep full sprite in-bounds (top-left position, so subtract full size)
    me.x = Math.max(0, Math.min(MAP_SIZE - SHARK_SIZE, me.x + (me.vx || 0) * dt));
    me.y = Math.max(0, Math.min(MAP_SIZE - SHARK_SIZE, me.y + (me.vy || 0) * dt));
    // Smoothly rotate towards cursor using actual on-screen shark center to avoid drift
    let desiredAngle = me.angle;
    if (mouse) {
        // Prefer the true on-screen position of the shark to handle zoom, camera, and layout precisely
        const selfEl = document.getElementById(`p-${selfId}`);
        let cx = window.innerWidth / 2, cy = window.innerHeight / 2;
        if (selfEl) {
            const r = selfEl.getBoundingClientRect();
            cx = r.left + r.width / 2;
            cy = r.top + r.height / 2;
        }
        const dx = mouse.x - cx;
        const dy = mouse.y - cy;
        if (dx !== 0 || dy !== 0)
            desiredAngle = Math.atan2(dy, dx);
    }
    const diff = Math.atan2(Math.sin(desiredAngle - me.angle), Math.cos(desiredAngle - me.angle));
    me.angle = me.angle + Math.min(1, 10 * dt) * diff;
    // Throttle server emits to ~30fps
    const now = performance.now();
    if (socket && selfId && now - throttleAt > 33) {
        throttleAt = now;
        const p = players[selfId];
        socket.volatile.emit('player:move', { x: p.x, y: p.y, angle: p.angle });
    }
}
function loop() {
    const now = performance.now();
    const dt = Math.min(0.033, (now - lastFrame) / 1000);
    lastFrame = now;
    const fps = 1 / Math.max(0.0001, dt);
    fpsEMA = fpsEMA ? fpsEMA * 0.9 + fps * 0.1 : fps;
    if (fpsEl)
        fpsEl.textContent = String(Math.round(fpsEMA));
    step(dt);
    // Pixel-perfect eat checks, throttled to ~15 FPS for better performance (was 20 FPS)
    const t = performance.now();
    if (t - lastEatCheckMs > 66) {
        lastEatCheckMs = t;
        checkEatCollisions();
    }
    render();
    requestAnimationFrame(loop);
}
function bindGameInteractions(container) {
    // Track mouse in viewport coordinates for consistent rotation
    const updateMouse = (e) => {
        mouse = { x: e.clientX, y: e.clientY };
    };
    window.addEventListener('pointermove', updateMouse);
    window.addEventListener('mousemove', updateMouse);
    // WASD + Arrow Keys movement input
    const onKey = (down) => (e) => {
        // Only handle keys during gameplay (avoid interfering with input fields/menus)
        if (!gameEl || gameEl.classList.contains('hidden'))
            return;
        const key = e.key;
        const k = key.toLowerCase();
        let handled = false;
        if (k === 'w' || key === 'ArrowUp') {
            keys.w = down;
            handled = true;
        }
        else if (k === 'a' || key === 'ArrowLeft') {
            keys.a = down;
            handled = true;
        }
        else if (k === 's' || key === 'ArrowDown') {
            keys.s = down;
            handled = true;
        }
        else if (k === 'd' || key === 'ArrowRight') {
            keys.d = down;
            handled = true;
        }
        // Developer testing: z key for WarriorX12 only
        else if (k === 'z' && down && myUsername === 'WarriorX12') {
            socket?.emit('dev:levelup');
            handled = true;
        }
        if (handled)
            e.preventDefault();
    };
    window.addEventListener('keydown', onKey(true));
    window.addEventListener('keyup', onKey(false));
    // Shooting: click/press to start hold fire, release to stop
    const down = (cx, cy) => { if (!gameEl || gameEl.classList.contains('hidden'))
        return; startHoldFire(); };
    const up = () => { stopHoldFire(); };
    window.addEventListener('mousedown', (e) => down(e.clientX, e.clientY));
    window.addEventListener('mouseup', up);
    window.addEventListener('pointerdown', (e) => down(e.clientX, e.clientY));
    window.addEventListener('pointerup', up);
    window.addEventListener('touchstart', () => { startHoldFire(); }, { passive: true });
    window.addEventListener('touchend', () => { stopHoldFire(); }, { passive: true });
    // Defensive: fade lingering projectiles periodically even if server skips an empty update
    setInterval(() => { if (!projectileLayer)
        return; for (const el of Array.from(projectileLayer.children)) {
        if (!el.classList.contains('out')) {
            el.classList.add('out');
            setTimeout(() => el.remove(), 240);
        }
    } }, 3000);
    // Spacebar hold-to-fire
    window.addEventListener('keydown', (e) => {
        if (!gameEl || gameEl.classList.contains('hidden'))
            return;
        const key = e.key;
        if (key === ' ' || key === 'Spacebar') {
            e.preventDefault();
            startHoldFire();
        }
    });
    window.addEventListener('keyup', (e) => {
        if (!gameEl || gameEl.classList.contains('hidden'))
            return;
        const key = e.key;
        if (key === ' ' || key === 'Spacebar') {
            e.preventDefault();
            stopHoldFire();
        }
    });
    // Prevent zoom shortcuts (FOV hack prevention)
    window.addEventListener('keydown', (e) => {
        // Prevent Cmd/Ctrl + Plus/Minus/0 (zoom shortcuts)
        if ((e.metaKey || e.ctrlKey) && (e.key === '+' || e.key === '-' || e.key === '=' || e.key === '0')) {
            e.preventDefault();
            return false;
        }
    }, { passive: false });
    // Prevent mouse wheel zoom
    window.addEventListener('wheel', (e) => {
        if (!gameEl || gameEl.classList.contains('hidden'))
            return;
        if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            return false;
        }
    }, { passive: false });
    // Prevent pinch zoom on trackpad
    window.addEventListener('gesturestart', (e) => {
        e.preventDefault();
    }, { passive: false });
    window.addEventListener('gesturechange', (e) => {
        e.preventDefault();
    }, { passive: false });
    window.addEventListener('gestureend', (e) => {
        e.preventDefault();
    }, { passive: false });
}
function initSocket(username) {
    myUsername = username; // Store for respawn
    // Dynamic socket URL: use localhost in dev, production URL in production
    const isDev = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
    const SOCKET_URL = isDev ? 'http://localhost:3002' : window.location.origin;
    console.log('Connecting to socket server:', SOCKET_URL);
    socket = io(SOCKET_URL);
    // Projectiles + death events
    socket.on('projectiles:update', (arr) => {
        updateProjectiles(arr || []);
    });
    socket.on('player:died', () => {
        const now = performance.now();
        const elapsedMs = Math.max(0, now - sessionStartMs);
        const mins = Math.floor(elapsedMs / 60000);
        const secs = Math.floor((elapsedMs % 60000) / 1000);
        const me = selfId ? players[selfId] : null;
        const score = me ? (me.score || 0) : 0;
        // Compute level from score using existing progression
        let lvl = 1;
        if (levelsReady && levelSteps.length > 0) {
            let remaining = score;
            for (let i = 0; i < levelSteps.length; i++) {
                const need = levelSteps[i] | 0;
                if (remaining >= need) {
                    remaining -= need;
                    lvl++;
                }
                else {
                    break;
                }
            }
        }
        if (deathTimeEl)
            deathTimeEl.textContent = `${mins}:${String(secs).padStart(2, '0')}`;
        if (deathScoreEl)
            deathScoreEl.textContent = String(score);
        if (deathLevelEl)
            deathLevelEl.textContent = String(lvl);
        deathOverlay?.classList.remove('hidden');
    });
    socket.on('player:respawned', (data) => {
        sessionStartMs = performance.now();
        deathOverlay?.classList.add('hidden');
        // Update local player state with respawn data
        if (selfId && data) {
            if (!players[selfId]) {
                players[selfId] = {
                    id: selfId,
                    x: data.x,
                    y: data.y,
                    angle: 0,
                    username: myUsername,
                    score: 0,
                    hp: data.hp,
                    dead: false
                };
            }
            else {
                players[selfId].x = data.x;
                players[selfId].y = data.y;
                players[selfId].hp = data.hp;
                players[selfId].dead = false;
                players[selfId].score = 0;
            }
            ensureSharkEl(selfId, players[selfId].username);
        }
    });
    socket.emit('player:join', username);
    socket.on('connect', () => {
        selfId = socket.id || null;
    });
    socket.on('gameState', (data) => {
        const payload = data && typeof data === 'object' && 'players' in data
            ? data
            : { players: data };
        // Players
        players = {};
        for (const [id, p] of Object.entries(payload.players)) {
            players[id] = { ...p };
            ensureSharkEl(id, p.username);
        }
        // Foods
        for (const [fid, el] of Array.from(foodEls.entries())) {
            removeFoodEl(fid);
        }
        foods = {};
        if (payload.foods && Array.isArray(payload.foods)) {
            for (const f of payload.foods) {
                foods[f.id] = f;
                ensureFoodEl(f);
            }
        }
    });
    socket.on('player:new', (p) => {
        players[p.id] = { ...p };
        ensureSharkEl(p.id, p.username);
    });
    socket.on('players:update', (data) => {
        const payload = data && typeof data === 'object' && 'players' in data
            ? data
            : { players: data };
        for (const [id, sp] of Object.entries(payload.players)) {
            if (id === selfId) {
                // Keep client prediction for position/angle; still accept authoritative score and HP/death
                const me = players[id] || (players[id] = { ...sp });
                if (sp.score !== undefined)
                    me.score = sp.score;
                if (sp.hp !== undefined)
                    me.hp = sp.hp;
                if (sp.dead !== undefined)
                    me.dead = sp.dead;
                continue;
            }
            const existing = players[id];
            if (!existing) {
                players[id] = { ...sp };
                ensureSharkEl(id, sp.username);
            }
            else {
                existing.x = sp.x;
                existing.y = sp.y;
                existing.angle = sp.angle;
                if (sp.score !== undefined)
                    existing.score = sp.score;
                if (sp.hp !== undefined)
                    existing.hp = sp.hp;
                if (sp.dead !== undefined)
                    existing.dead = sp.dead;
            }
        }
    });
    // Fish food movement updates (server-authoritative)
    socket.on('foods:update', (arr) => {
        if (!Array.isArray(arr))
            return;
        for (const u of arr) {
            // Update local cache
            if (foods[u.id]) {
                foods[u.id].x = u.x;
                foods[u.id].y = u.y;
            }
            else {
                foods[u.id] = { id: u.id, x: u.x, y: u.y };
            }
            // Ensure element exists and update its position
            ensureFoodEl({ id: u.id, x: u.x, y: u.y });
        }
    });
    socket.on('player:left', (id) => {
        delete players[id];
        removeSharkEl(id);
    });
    socket.on('food:respawn', (msg) => {
        if (!msg)
            return;
        const id = msg.removedId;
        const old = foods[id];
        // Animate old food disappearing
        const oldEl = document.getElementById(`f-${id}`);
        if (oldEl) {
            oldEl.classList.add('food--eaten');
            // FX overlays (initialized once when DOM is ready)
            fxVignetteEl = document.getElementById('fx-vignette');
            fxCriticalEl = document.getElementById('fx-critical');
            setTimeout(() => removeFoodEl(id), 130);
        }
        else {
            removeFoodEl(id);
        }
        // Bite feedback for local player if close to eaten food
        if (selfId && old) {
            const me = players[selfId];
            if (me) {
                const dx = (me.x + SHARK_HALF) - old.x;
                const dy = (me.y + SHARK_HALF) - old.y;
                const maxR = SHARK_HALF + FOOD_RADIUS + 18;
                if ((dx * dx + dy * dy) <= (maxR * maxR)) {
                    biteUntil.set(selfId, performance.now() + 160);
                    // Eat pop effect
                    const pop = document.createElement('div');
                    pop.className = 'eat-pop';
                    pop.style.left = `${old.x}px`;
                    pop.style.top = `${old.y}px`;
                    world.appendChild(pop);
                    setTimeout(() => { if (pop.parentElement)
                        pop.parentElement.removeChild(pop); }, 320);
                }
            }
        }
        lastEatEmit.delete(id);
        // Spawn new food
        foods[msg.food.id] = msg.food;
        ensureFoodEl(msg.food);
    });
}
function startGame(username) {
    landingEl.classList.add('hidden');
    gameEl.classList.remove('hidden');
    sessionStartMs = performance.now();
    // Remove top padding so the world truly centers to viewport
    gameEl.style.paddingTop = '0px';
    // Hide top bar during gameplay
    document.querySelector('.site-header')?.classList.add('hidden');
    // Bubbles are server-controlled; wait for seeds
    if (bubbleLayer) {
        bubbleLayer.innerHTML = '';
    }
    initSocket(username);
    // Preload collision maps; the game can start rendering immediately and checks will activate when ready
    loadCollisionMaps().catch(() => { });
    // Server-authoritative overlays
    socket.on('leaderboard:update', (list) => {
        updateLeaderboard(list);
        // Track current top score for score bar progress
        if (Array.isArray(list) && list.length > 0) {
            topScore = Math.max(0, list[0].score | 0);
        }
    });
    // Level progression table (server-provided)
    socket.on('levels:init', (steps) => {
        const arr = Array.isArray(steps) ? steps : (steps && Array.isArray(steps.steps) ? steps.steps : []);
        levelSteps = arr.map((v) => Math.max(0, Number(v) | 0));
        levelsReady = levelSteps.length > 0;
    });
    // Tail offsets and scales for all shark types (server-provided)
    socket.on('tails:init', (map) => {
        try {
            if (map && typeof map === 'object') {
                for (const k of Object.keys(map)) {
                    const v = map[k];
                    if (v && typeof v.x === 'number' && typeof v.y === 'number') {
                        sharkTailOffsets.set(k, { x: v.x, y: v.y });
                        if (typeof v.s === 'number' && v.s > 0)
                            sharkScales.set(k, v.s);
                    }
                }
            }
        }
        catch { }
    });
    socket.on('server:pong', (t0) => {
        const rtt = Math.max(0, performance.now() - t0);
        msEMA = msEMA ? (msEMA * 0.7 + rtt * 0.3) : rtt;
        if (msEl)
            msEl.textContent = String(Math.round(msEMA));
    });
    socket.on('bubbles:init', (seeds) => {
        createBubbleLayerFromSeeds(seeds);
    });
    // Kill feed & notifications
    socket.on('feed:kill', (payload) => { try {
        addKillFeedItem(payload);
    }
    catch { } });
    socket.on('notify', (msg) => { if (msg && msg.text)
        showTopNotice(msg.text, Math.max(1000, Math.min(10000, msg.ttlMs || 5000))); });
    // Evolution event (delay sprite swap slightly so smoke can cover the shark first)
    socket.on('player:evolved', (data) => {
        try {
            const now = performance.now();
            // Update player data and schedule visual swap
            const player = players[data.id];
            if (player) {
                const oldType = player.sharkType;
                player.level = data.level;
                player.sharkType = data.sharkType;
                if (oldType && oldType !== data.sharkType) {
                    evolutionPrevSharkType.set(data.id, oldType);
                    evolutionHoldUntil.set(data.id, now + 380); // ~0.38s cover before swap
                }
            }
            // Store tail offset for trail bubbles
            if (data.tailOffset) {
                sharkTailOffsets.set(data.sharkType, data.tailOffset);
            }
            // Visual effects
            if (data.id === selfId) {
                // Client-side: intense screen shake for self
                addScreenShake(25); // More intense than damage shake
                const sharkName = data.sharkType.replace('.png', '');
                showTopNotice(`You evolved to ${sharkName}!`, 3000);
            }
            // Server-side smoke particles are emitted separately; just log
            // console.log(`${data.username} evolved to ${data.sharkType} at level ${data.level}`);
        }
        catch (e) {
            console.error('Evolution event error:', e);
        }
    });
    // Initialize Baby Shark tail offset (default starting shark)
    // This will be used until the player evolves and receives updated tail offsets
    if (tailAnchor) {
        // Convert from absolute mask coordinates to offset from center
        sharkTailOffsets.set('Baby Shark.png', {
            x: tailAnchor.x - 128,
            y: tailAnchor.y - 128
        });
    }
    // Evolution smoke particle effect (server-authoritative)
    socket.on('effect:smoke', (data) => {
        try {
            const p = players[data.playerId];
            const key = p?.sharkType || 'Baby Shark.png';
            const sEvt = (typeof data.s === 'number' && data.s > 0) ? data.s : undefined;
            const sLocal = sharkScales.get(key) || 1;
            const s = sEvt ?? sLocal;
            spawnEvolutionSmoke(data.x, data.y, s);
        }
        catch (e) {
            console.error('Smoke effect error:', e);
        }
    });
    // Shark-to-shark collision damage event
    socket.on('shark:collision', (data) => {
        try {
            // Trigger collision effects (screen shake, red vignette)
            if (data.damage > 0) {
                addScreenShake(Math.min(10, data.damage * 0.5)); // Moderate shake for collision
                pulseVignette();
                // The HP decrease will be detected in the render loop and trigger the red flash
            }
        }
        catch (e) {
            console.error('Collision effect error:', e);
        }
    });
    if (pingTimer)
        clearInterval(pingTimer);
    pingTimer = window.setInterval(() => { try {
        socket?.emit('client:ping', performance.now());
    }
    catch { } }, 2000);
    // Camera centering is handled each frame in render(); ticker removed for performance
    requestAnimationFrame(loop);
}
function addKillFeedItem(payload) {
    if (!payload)
        return;
    const el = document.getElementById('kill-feed');
    if (!el)
        return;
    const item = document.createElement('div');
    item.className = 'feed-item';
    const v = payload.victim?.username || 'Unknown';
    const k = payload.killer?.username || 'Unknown';
    const a = payload.assister?.username || '';
    let html = '';
    if (payload.mode === 'assist' && a) {
        html = `<span class="who">${escapeHtml(a)}</span> <span class="assist">assisted</span> <span class="who">${escapeHtml(k)}</span> <span class="what">in killing</span> <span class="who">${escapeHtml(v)}</span>`;
    }
    else if (payload.mode === 'shared' && a) {
        html = `<span class="who">${escapeHtml(k)}</span> <span class="what">and</span> <span class="who">${escapeHtml(a)}</span> <span class="what">eliminated</span> <span class="who">${escapeHtml(v)}</span>`;
    }
    else {
        html = `<span class="who">${escapeHtml(k)}</span> <span class="what">killed</span> <span class="who">${escapeHtml(v)}</span>`;
    }
    item.innerHTML = html;
    el.prepend(item);
    // Only remove oldest item when feed overflows (max 6 items)
    // No auto-delete timeout - items stay until pushed out by new kills
    if (el.children.length > 6) {
        const oldest = el.lastElementChild;
        if (oldest) {
            oldest.classList.add('feed-item--removing');
            oldest.animate([
                { opacity: 1, transform: 'translateX(0)' },
                { opacity: 0, transform: 'translateX(20px)' }
            ], { duration: 200, easing: 'ease-out' }).onfinish = () => {
                oldest.remove();
            };
        }
    }
}
function showTopNotice(text, ttlMs = 5000) {
    const el = document.getElementById('top-notify');
    if (!el)
        return;
    const n = document.createElement('div');
    n.className = 'notice';
    n.textContent = text;
    el.appendChild(n);
    setTimeout(() => { n.style.animation = 'notifyOut .18s ease forwards'; setTimeout(() => n.remove(), 200); }, ttlMs);
}
function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] || c));
}
function main() {
    world = document.getElementById('world');
    gameEl = document.getElementById('game');
    landingEl = document.getElementById('landing');
    bubbleLayer = document.getElementById('bubble-layer');
    posXEl = document.getElementById('posx');
    posYEl = document.getElementById('posy');
    minimap = document.getElementById('minimap');
    ctx = minimap.getContext('2d');
    // HUD bars
    levelFill = document.getElementById('level-fill');
    levelText = document.getElementById('level-text');
    scoreFill = document.getElementById('score-fill');
    scoreText = document.getElementById('score-text');
    projectileLayer = document.getElementById('projectiles');
    deathOverlay = document.getElementById('death-overlay');
    btnRespawn = document.getElementById('btn-respawn');
    btnHome = document.getElementById('btn-home');
    deathTimeEl = document.getElementById('death-time');
    deathScoreEl = document.getElementById('death-score');
    deathLevelEl = document.getElementById('death-level');
    if (btnRespawn) {
        btnRespawn.onclick = () => {
            console.log('Respawn button clicked, socket:', socket);
            if (socket) {
                socket.emit('player:respawn');
                console.log('Emitted player:respawn');
            }
            else {
                console.error('Socket is null, cannot respawn');
            }
        };
    }
    if (btnHome) {
        btnHome.onclick = () => {
            deathOverlay?.classList.add('hidden');
            gameEl.classList.add('hidden');
            landingEl.classList.remove('hidden');
            socket?.disconnect();
            socket = null;
        };
    }
    fpsEl = document.getElementById('fps');
    msEl = document.getElementById('ms');
    lbEl = document.getElementById('leaderboard');
    // Ensure world element exists and has proper initial transform
    if (world) {
        world.style.transformOrigin = '0 0';
        world.style.willChange = 'transform';
    }
    bindGameInteractions(document.body);
    // Header / account
    btnLogin = document.getElementById('btn-login');
    btnSignup = document.getElementById('btn-signup');
    accountChip = document.getElementById('account-chip');
    accountName = document.getElementById('account-name');
    accountMenu = document.getElementById('account-menu');
    menuLogout = document.getElementById('menu-logout');
    menuReset = document.getElementById('menu-reset');
    // Modals
    modalSignup = document.getElementById('modal-signup');
    suUser = document.getElementById('su-username');
    suPass = document.getElementById('su-password');
    suErrors = document.getElementById('su-errors');
    suCancel = document.getElementById('su-cancel');
    suSubmit = document.getElementById('su-submit');
    modalLogin = document.getElementById('modal-login');
    liUser = document.getElementById('li-username');
    liPass = document.getElementById('li-password');
    liErrors = document.getElementById('li-errors');
    liCancel = document.getElementById('li-cancel');
    liSubmit = document.getElementById('li-submit');
    modalReset = document.getElementById('modal-reset');
    rpPass = document.getElementById('rp-password');
    rpConfirm = document.getElementById('rp-confirm');
    rpErrors = document.getElementById('rp-errors');
    rpCancel = document.getElementById('rp-cancel');
    rpSubmit = document.getElementById('rp-submit');
    modalProfile = document.getElementById('modal-profile');
    profileClose = document.getElementById('profile-close');
    menuProfile = document.getElementById('menu-profile');
    // Password strength indicators
    suStrengthFill = document.getElementById('su-strength-fill');
    suStrengthText = document.getElementById('su-strength-text');
    rpStrengthFill = document.getElementById('rp-strength-fill');
    rpStrengthText = document.getElementById('rp-strength-text');
    const input = document.getElementById('username');
    const play = document.getElementById('play');
    // Event handlers
    btnLogin.addEventListener('click', () => { liErrors.textContent = ''; openModal(modalLogin); liUser.focus(); });
    btnSignup.addEventListener('click', () => { suErrors.textContent = ''; openModal(modalSignup); suUser.focus(); });
    // Password strength listeners
    suPass.addEventListener('input', () => {
        updatePasswordStrength(suPass.value, suStrengthFill, suStrengthText);
    });
    rpPass.addEventListener('input', () => {
        updatePasswordStrength(rpPass.value, rpStrengthFill, rpStrengthText);
    });
    suCancel.addEventListener('click', () => closeModal(modalSignup));
    liCancel.addEventListener('click', () => closeModal(modalLogin));
    rpCancel.addEventListener('click', () => closeModal(modalReset));
    profileClose.addEventListener('click', () => closeModal(modalProfile));
    suSubmit.addEventListener('click', async () => {
        suErrors.textContent = '';
        const u = (suUser.value || '').trim().slice(0, 16); // Max 16 chars for account username
        if (u.length === 0) {
            suErrors.textContent = 'Username cannot be empty';
            return;
        }
        const p = suPass.value || '';
        const r = await signup(u, p);
        if (!r.ok) {
            suErrors.textContent = r.error || 'Sign up failed';
            return;
        }
        setSession(r.data);
        closeModal(modalSignup);
        setUIFromSession();
    });
    liSubmit.addEventListener('click', async () => {
        liErrors.textContent = '';
        const u = (liUser.value || '').trim().slice(0, 16);
        const p = liPass.value || '';
        // Show loading overlay
        closeModal(modalLogin);
        showLoading('Logging in...');
        // Small delay for visual feedback
        await new Promise(resolve => setTimeout(resolve, 800));
        const r = await login(u, p);
        hideLoading();
        if (!r.ok) {
            openModal(modalLogin);
            liErrors.textContent = r.error || 'Login failed';
            return;
        }
        setSession(r.data);
        setUIFromSession();
    });
    // Account dropdown events
    accountChip.addEventListener('click', () => {
        // Guard: only open menu if logged in
        if (!getSession())
            return;
        const isOpen = !accountMenu.classList.contains('hidden');
        accountMenu.classList.toggle('hidden');
        accountChip.setAttribute('aria-expanded', String(!isOpen));
    });
    document.addEventListener('click', (e) => {
        if (!accountChip.contains(e.target)) {
            accountMenu.classList.add('hidden');
            accountChip.setAttribute('aria-expanded', 'false');
        }
    });
    accountChip.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            accountMenu.classList.add('hidden');
            accountChip.setAttribute('aria-expanded', 'false');
        }
    });
    menuProfile.addEventListener('click', () => {
        accountMenu.classList.add('hidden');
        accountChip.setAttribute('aria-expanded', 'false');
        // Populate profile data
        const session = getSession();
        if (session) {
            const profileGames = document.getElementById('profile-games');
            const profileScore = document.getElementById('profile-score');
            const profileDate = document.getElementById('profile-date');
            // For now, show placeholder data - in a real app, this would come from the server
            profileGames.textContent = '0';
            profileScore.textContent = '0';
            // Format the date
            const date = new Date(session.timeCreated);
            profileDate.textContent = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
        }
        openModal(modalProfile);
    });
    menuLogout.addEventListener('click', async () => {
        accountMenu.classList.add('hidden');
        accountChip.setAttribute('aria-expanded', 'false');
        // Show loading overlay
        showLoading('Logging out...');
        // Small delay for visual feedback
        await new Promise(resolve => setTimeout(resolve, 600));
        clearSession();
        const input = document.getElementById('username');
        if (input)
            input.value = '';
        hideLoading();
        setUIFromSession();
    });
    menuReset.addEventListener('click', () => {
        accountMenu.classList.add('hidden');
        accountChip.setAttribute('aria-expanded', 'false');
        rpErrors.textContent = '';
        rpPass.value = '';
        rpConfirm.value = '';
        updatePasswordStrength('', rpStrengthFill, rpStrengthText);
        openModal(modalReset);
        rpPass.focus();
    });
    rpSubmit.addEventListener('click', async () => {
        rpErrors.textContent = '';
        const np = rpPass.value || '';
        const confirm = rpConfirm.value || '';
        // Validate passwords match
        if (np !== confirm) {
            rpErrors.textContent = 'Passwords do not match';
            return;
        }
        const r = await resetPassword(np);
        if (!r.ok) {
            rpErrors.textContent = r.error || 'Failed to update password';
            return;
        }
        closeModal(modalReset);
    });
    play.addEventListener('click', async () => {
        const s = getSession();
        const name = s ? s.username : (input.value || '').trim().slice(0, 20); // Max 20 chars for in-game name
        if (!name) {
            openModal(modalSignup);
            return;
        }
        // Show connecting overlay
        showLoading('Connecting to server...');
        // Small delay for visual feedback
        await new Promise(resolve => setTimeout(resolve, 800));
        // Hide loading and start game
        hideLoading();
        startGame(name);
    });
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter')
            document.getElementById('play').click();
    });
    setUIFromSession();
}
document.addEventListener('DOMContentLoaded', main);
