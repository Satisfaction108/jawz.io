"use strict";
const MAP_SIZE = 4000;
const SELF_SPEED = 495; // px/s (1.5x boost)
const SHARK_SIZE = 256; // px (exact baby shark sprite size)
const SHARK_HALF = SHARK_SIZE / 2;
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
// --- FX toggles (modular, easy to turn on/off) ---
const FX = {
    damageShake: true,
    redVignette: true,
    criticalBlur: true,
    waterRipples: true,
    impactFlash: true,
    waterTrail: true,
    scorePopup: true,
};
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
function spawnRipple(x, y, size = 56) {
    if (!FX.waterRipples)
        return;
    const el = document.createElement('div');
    el.className = 'ripple';
    el.style.width = `${size}px`;
    el.style.height = `${size}px`;
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    world.appendChild(el);
    setTimeout(() => el.remove(), 450);
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
function spawnTrailBubbleAt(x, y, angle) {
    if (!FX.waterTrail)
        return;
    const el = document.createElement('div');
    el.className = 'trail-bubble';
    // Compute the world-space tail anchor by rotating the sprite-local tail point around sprite center
    const rot = angle + Math.PI; // matches sprite rotate offset
    const cos = Math.cos(rot), sin = Math.sin(rot);
    let ax = x + SHARK_HALF, ay = y + SHARK_HALF; // default: center
    if (tailAnchor) {
        const dx = tailAnchor.x - SHARK_HALF;
        const dy = tailAnchor.y - SHARK_HALF;
        ax = x + SHARK_HALF + (dx * cos - dy * sin);
        ay = y + SHARK_HALF + (dx * sin + dy * cos);
    }
    // Emit slightly behind the facing direction with a small lateral spread
    const baseOff = 8 + Math.random() * 6; // 8..14 px behind the tail
    const spread = (Math.random() * 16) - 8; // -8..+8 px sideways
    const fx = Math.cos(angle), fy = Math.sin(angle);
    const px = -Math.sin(angle), py = Math.cos(angle);
    const bx = ax - fx * baseOff + px * spread;
    const by = ay - fy * baseOff + py * spread;
    // Use CSS variables consumed by the animation so transform isn't overridden
    el.style.setProperty('--x', `${Math.round(bx - 8)}px`);
    el.style.setProperty('--y', `${Math.round(by - 8)}px`);
    world.appendChild(el);
    setTimeout(() => el.remove(), 900);
}
function spawnScorePopup(x, y, delta) {
    if (!FX.scorePopup)
        return;
    const el = document.createElement('div');
    el.className = 'score-popup';
    el.textContent = `+${delta}`;
    el.style.left = `${x + SHARK_HALF}px`;
    el.style.top = `${y - 10}px`;
    world.appendChild(el);
    setTimeout(() => el.remove(), 800);
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
    if (now - lastClientShotAt < CLIENT_COOLDOWN_MS - 12)
        return; // tiny slack
    lastClientShotAt = now;
    const { cx, cy } = aimCoords();
    emitShootAtClientCoords(cx, cy);
}
function startHoldFire() {
    if (fireHeld)
        return;
    fireHeld = true;
    tryFireOnce();
    fireTimer = window.setInterval(tryFireOnce, CLIENT_COOLDOWN_MS);
}
function stopHoldFire() {
    fireHeld = false;
    if (fireTimer !== null) {
        clearInterval(fireTimer);
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
                    spawnRipple(Math.round(pos.x), Math.round(pos.y), 42);
                el.classList.add('out');
                setTimeout(() => el.remove(), 240);
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
                        const s = SHARK_SIZE;
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
                            // Compute tail anchor from mask (sprite is left-facing by default; tail is the rightmost opaque edge)
                            tailAnchor = computeTailAnchorFromAlpha(sharkAlpha, SHARK_SIZE);
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
                    const c = document.createElement('canvas');
                    c.width = SHARK_SIZE;
                    c.height = SHARK_SIZE;
                    const cctx = c.getContext('2d');
                    cctx.clearRect(0, 0, SHARK_SIZE, SHARK_SIZE);
                    const nw = sharkImg.naturalWidth || sharkImg.width;
                    const nh = sharkImg.naturalHeight || sharkImg.height;
                    const scale = Math.max(SHARK_SIZE / nw, SHARK_SIZE / nh); // cover
                    const dw = nw * scale, dh = nh * scale;
                    const dx = (SHARK_SIZE - dw) / 2, dy = (SHARK_SIZE - dh) / 2; // centered
                    cctx.drawImage(sharkImg, dx, dy, dw, dh);
                    sharkAlpha = cctx.getImageData(0, 0, SHARK_SIZE, SHARK_SIZE).data; // RGBA
                    // Compute tail anchor from image alpha if text mask not provided
                    tailAnchor = computeTailAnchorFromAlpha(sharkAlpha, SHARK_SIZE);
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
    const maxDist = SHARK_HALF + FOOD_RADIUS + 16; // increased tolerance to reduce near-miss rejections
    if ((dx * dx + dy * dy) > (maxDist * maxDist))
        return false;
    const rot = me.angle + Math.PI;
    const cos = Math.cos(rot), sin = Math.sin(rot);
    const sSize = SHARK_SIZE;
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
            // vector from shark center
            const vx = wx - cx;
            const vy = wy - cy;
            // rotate by -rot: x' = x cos + y sin ; y' = -x sin + y cos
            const lx = vx * cos + vy * sin;
            const ly = -vx * sin + vy * cos;
            const sx = Math.round(lx + sSize / 2);
            const sy = Math.round(ly + sSize / 2);
            // 3x3 neighborhood to compensate for rotation/rounding
            for (let oy = -1; oy <= 1; oy++) {
                for (let ox = -1; ox <= 1; ox++) {
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
let modalReset, rpPass, rpErrors, rpCancel, rpSubmit;
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
    return { isValid: errors.length === 0, errors };
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
function createBubbleLayer(n = 24) {
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
// Camera helpers: always keep the local player's shark centered on screen
function updateCameraToSelf() {
    if (!selfId)
        return;
    const self = players[selfId];
    if (!self)
        return;
    // Compute CSS-pixel offsets so the shark center is exactly at the viewport center
    const z = CAMERA_ZOOM;
    camera.x = Math.round((window.innerWidth / 2) - (self.x + SHARK_HALF) * z);
    camera.y = Math.round((window.innerHeight / 2) - (self.y + SHARK_HALF) * z);
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
        const img = document.createElement('div');
        img.className = 'shark__img';
        const flash = document.createElement('div');
        flash.className = 'shark__flash';
        const name = document.createElement('div');
        name.className = 'shark__name';
        name.textContent = username;
        const hp = document.createElement('div');
        hp.className = 'shark__hp';
        hp.innerHTML = '<div class="shark__hpTrack"><div class="shark__hpFill" style="width:100%"></div></div>';
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
}
function render() {
    // 1) Update camera so the self shark is at the exact screen center
    updateCameraToSelf();
    // 2) Apply camera transform to move the world (not the shark)
    applyCameraTransform();
    // 3) Place and orient all sharks in world space
    for (const p of Object.values(players)) {
        const el = ensureSharkEl(p.id, p.username);
        // Position container (translate only) so the name does not rotate/flip
        el.style.transform = `translate3d(${Math.round(p.x)}px, ${Math.round(p.y)}px, 0)`;
        // Rotate/mirror only the shark image so the label remains upright and unflipped
        const a = p.angle;
        let deg = (a * 180 / Math.PI) % 360;
        if (deg < 0)
            deg += 360; // normalize 0..360
        const flipX = (deg > 270 || deg < 90) ? -1 : 1; // right-side quadrants => flip
        const imgEl = el.querySelector('.shark__img');
        const flashEl = el.querySelector('.shark__flash');
        if (imgEl) {
            const now = performance.now();
            const biteScale = (biteUntil.get(p.id) || 0) > now ? 1.08 : 1.0;
            const tr = `rotate(${(a + Math.PI)}rad) scaleY(${flipX}) scale(${biteScale})`;
            imgEl.style.transform = tr;
            if (flashEl)
                flashEl.style.transform = tr;
        }
        // Dead visual state
        if (p.dead)
            el.classList.add('shark--dead');
        else
            el.classList.remove('shark--dead');
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
        // Water trail: throttle and only when moving
        const nowMs2 = performance.now();
        const lastT = lastTrailTimeById.get(p.id) || 0;
        const prevPos = lastPosById.get(p.id);
        if (nowMs2 - lastT > 160 && prevPos && (Math.abs(prevPos.x - p.x) + Math.abs(prevPos.y - p.y) > 2)) {
            spawnTrailBubbleAt(p.x, p.y, p.angle);
            lastTrailTimeById.set(p.id, nowMs2);
        }
        lastPosById.set(p.id, { x: p.x, y: p.y });
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
                spawnScorePopup(self.x, self.y, delta);
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
    // Minimap
    if (ctx) {
        const t = performance.now();
        if (t - lastMinimapMs > 100) {
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
    // Pixel-perfect eat checks, throttled to ~20 FPS to reduce cost
    const t = performance.now();
    if (t - lastEatCheckMs > 50) {
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
}
function initSocket(username) {
    socket = io('http://localhost:3002');
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
    socket.on('player:respawned', () => {
        sessionStartMs = performance.now();
        deathOverlay?.classList.add('hidden');
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
    socket.on('server:pong', (t0) => {
        const rtt = Math.max(0, performance.now() - t0);
        msEMA = msEMA ? (msEMA * 0.7 + rtt * 0.3) : rtt;
        if (msEl)
            msEl.textContent = String(Math.round(msEMA));
    });
    socket.on('bubbles:init', (seeds) => {
        createBubbleLayerFromSeeds(seeds);
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
        btnRespawn.onclick = () => { socket?.emit('player:respawn'); };
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
    rpErrors = document.getElementById('rp-errors');
    rpCancel = document.getElementById('rp-cancel');
    rpSubmit = document.getElementById('rp-submit');
    const input = document.getElementById('username');
    const play = document.getElementById('play');
    // Event handlers
    btnLogin.addEventListener('click', () => { liErrors.textContent = ''; openModal(modalLogin); liUser.focus(); });
    btnSignup.addEventListener('click', () => { suErrors.textContent = ''; openModal(modalSignup); suUser.focus(); });
    suCancel.addEventListener('click', () => closeModal(modalSignup));
    liCancel.addEventListener('click', () => closeModal(modalLogin));
    rpCancel.addEventListener('click', () => closeModal(modalReset));
    suSubmit.addEventListener('click', async () => {
        suErrors.textContent = '';
        const u = (suUser.value || '').trim().slice(0, 16);
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
        const r = await login(u, p);
        if (!r.ok) {
            liErrors.textContent = r.error || 'Login failed';
            return;
        }
        setSession(r.data);
        closeModal(modalLogin);
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
    menuLogout.addEventListener('click', () => {
        clearSession();
        const input = document.getElementById('username');
        if (input)
            input.value = '';
        accountMenu.classList.add('hidden');
        accountChip.setAttribute('aria-expanded', 'false');
        setUIFromSession();
    });
    menuReset.addEventListener('click', () => { rpErrors.textContent = ''; rpPass.value = ''; openModal(modalReset); rpPass.focus(); });
    rpSubmit.addEventListener('click', async () => {
        const np = rpPass.value || '';
        const r = await resetPassword(np);
        if (!r.ok) {
            rpErrors.textContent = r.error || 'Failed to update password';
            return;
        }
        closeModal(modalReset);
    });
    play.addEventListener('click', () => {
        const s = getSession();
        if (s) {
            startGame(s.username);
            return;
        }
        const name = (input.value || '').trim().slice(0, 16);
        if (!name) {
            openModal(modalSignup);
            return;
        }
        startGame(name);
    });
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter')
            document.getElementById('play').click();
    });
    setUIFromSession();
}
document.addEventListener('DOMContentLoaded', main);
