// Socket.IO client is loaded globally via CDN in index.html
// Declare the global `io` to avoid bundling requirements.
declare const io: (url: string, opts?: any) => any;
type Socket = ReturnType<typeof io>;

type Player = {
  id: string;
  username: string;
  x: number;
  y: number;
  angle: number;
  score: number;
  hp?: number;   // server-authoritative health (0-100)
  dead?: boolean; // death state
  level?: number; // current level (1-100+)
  sharkType?: string; // current shark sprite filename (e.g., "baby shark.png")
  targetX?: number;
  targetY?: number;
  vx?: number;
  vy?: number;
  abilities?: {
    quickDash?: { cooldownUntil: number; activeUntil: number };
    bubbleShield?: { cooldownUntil: number; activeUntil: number };
  };
};

const MAP_SIZE = 4000;
const SELF_SPEED = 495; // px/s (1.5x boost)

const SHARK_SIZE = Math.round(256 * (2/3)); // px (2/3 of original 256px = ~171px)
const SHARK_HALF = SHARK_SIZE / 2;
const SHARK_MASK_SIZE = 256; // Original mask size (masks are still 256x256)
const SHARK_SCALE = SHARK_SIZE / SHARK_MASK_SIZE; // Base scale (2/3)
const CAMERA_ZOOM = 0.8; // wider FOV (1.0 = no zoom)

// Visual constants
const BUBBLE_SIZE = 50; // base reference for gameplay-related sizes
const DECOR_BUBBLE_SIZE = 80; // px, explicit decorative bubble size as requested
const FISHFOOD_SIZE = Math.round(50 * 0.75); // keep food size stable (decoupled from decorative bubble size)
const FOOD_RADIUS = FISHFOOD_SIZE / 2;


let socket: Socket | null = null;
let players: Record<string, Player> = {};
let topScore: number = 0; // highest score on server (from leaderboard)
let levelSteps: number[] = []; // XP needed to go from level L to L+1, zero-based index (0 => 1->2)
let levelsReady: boolean = false;

let selfId: string | null = null;
let myUsername: string = 'Player'; // Store username for respawn
let world: HTMLDivElement;
let gameEl: HTMLDivElement;
let landingEl: HTMLElement;
let scoreFill: HTMLElement;
let scoreText: HTMLElement;
let levelFill: HTMLElement;
let levelText: HTMLElement;
let sharkNameEl: HTMLElement;

// Abilities system
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

let abilitiesData: AbilitiesData | null = null;
const abilityStates = new Map<string, { cooldownUntil: number; activeUntil: number }>();

// Load abilities configuration
async function loadAbilitiesConfig() {
  try {
    const response = await fetch('/abilities/abilities.json');
    abilitiesData = await response.json();
    console.log('✓ Abilities configuration loaded');

    // Initialize ability states
    abilityStates.set('quickDash', { cooldownUntil: 0, activeUntil: 0 });
    abilityStates.set('bubbleShield', { cooldownUntil: 0, activeUntil: 0 });

    // Update tooltips with loaded data
    updateAbilityTooltips();
  } catch (err) {
    console.error('Failed to load abilities config:', err);
  }
}

function updateAbilityTooltips() {
  if (!abilitiesData) return;

  const speedBoostEl = document.getElementById('ability-speed-boost');
  const bubbleShieldEl = document.getElementById('ability-bubble-shield');

  if (speedBoostEl) {
    const desc = speedBoostEl.querySelector('.ability-icon__tooltip-desc');
    if (desc) desc.textContent = abilitiesData.abilities.quickDash.description;
  }

  if (bubbleShieldEl) {
    const desc = bubbleShieldEl.querySelector('.ability-icon__tooltip-desc');
    if (desc) desc.textContent = abilitiesData.abilities.bubbleShield.description;
  }
}

function updateAbilityUI() {
  const now = Date.now();

  // Update each ability icon
  for (const [abilityId, state] of abilityStates.entries()) {
    const iconEl = document.querySelector(`[data-ability-id="${abilityId}"]`) as HTMLElement;
    if (!iconEl) continue;

    const cooldownEl = iconEl.querySelector('.ability-icon__cooldown') as HTMLElement;
    if (!cooldownEl) continue;

    // Check if active
    const isActive = now < state.activeUntil;
    if (isActive) {
      iconEl.classList.add('active');
    } else {
      iconEl.classList.remove('active');
    }

    // Check if on cooldown
    const isOnCooldown = now < state.cooldownUntil;
    if (isOnCooldown) {
      iconEl.classList.add('on-cooldown');
      // Calculate cooldown progress (0-100%)
      const totalCooldown = state.cooldownUntil - (state.activeUntil || state.cooldownUntil - 5000);
      const remaining = state.cooldownUntil - now;
      const progress = Math.max(0, Math.min(100, (remaining / totalCooldown) * 100));
      cooldownEl.style.height = `${progress}%`;
    } else {
      iconEl.classList.remove('on-cooldown');
      cooldownEl.style.height = '0%';
    }
  }
}

function activateAbility(abilityId: 'quickDash' | 'bubbleShield') {
  console.log(`[CLIENT] activateAbility called for ${abilityId}`);
  console.log(`[CLIENT] socket connected: ${socket?.connected}, selfId: ${selfId}`);

  if (!socket || !selfId) {
    console.warn(`[CLIENT] Cannot activate: socket=${!!socket}, selfId=${selfId}`);
    return;
  }

  const state = abilityStates.get(abilityId);
  if (!state) {
    console.warn(`[CLIENT] No state found for ${abilityId}`);
    return;
  }

  const now = Date.now();
  console.log(`[CLIENT] ${abilityId} state: activeUntil=${state.activeUntil}, cooldownUntil=${state.cooldownUntil}, now=${now}`);

  // Check if on cooldown
  if (now < state.cooldownUntil) {
    console.log(`[CLIENT] Ability ${abilityId} is on cooldown (${state.cooldownUntil - now}ms remaining)`);
    return;
  }

  // Check if already active
  if (now < state.activeUntil) {
    console.log(`[CLIENT] Ability ${abilityId} is already active (${state.activeUntil - now}ms remaining)`);
    return;
  }

  // Emit activation to server
  console.log(`[CLIENT] Emitting ability:activate for ${abilityId}`);
  socket.emit('ability:activate', { abilityId });
  console.log(`[CLIENT] Activated ability: ${abilityId}`);
}


let projectileLayer: HTMLDivElement;
let projectiles: Record<number, { x: number; y: number }> = {};

let deathOverlay: HTMLDivElement;
let btnRespawn: HTMLButtonElement;
let btnHome: HTMLButtonElement;
let deathScoreEl: HTMLElement; let deathLevelEl: HTMLElement; let deathTimeEl: HTMLElement;
let sessionStartMs = 0;

// --- FX toggles (modular, easy to turn on/off) - optimized for performance ---
const FX = {
  damageShake: true,
  redVignette: true,
  criticalBlur: true,
  waterRipples: true,
  impactFlash: true,
  waterTrail: true,  // Throttled to reduce DOM creation
  scorePopup: true,
};

// Performance: limit concurrent effect elements - OPTIMIZED for better FPS
const MAX_RIPPLES = 5; // Reduced from 8
const MAX_TRAIL_BUBBLES = 12; // Reduced from 24 (150ms spawn = ~8 concurrent at 900ms lifetime)
const MAX_SCORE_POPUPS = 4; // Reduced from 6
let activeRipples = 0;
let activeTrailBubbles = 0;
let activeScorePopups = 0;

// Track active score popups for position updates
const activeScorePopupEls: Array<{ el: HTMLDivElement; playerId: string; startTime: number }> = [];

// Track which players have had death animation triggered
const deathAnimTriggered = new Set<string>();

// FX state and helpers
let fxVignetteEl: HTMLDivElement;
let fxCriticalEl: HTMLDivElement;
let fxParticlesEl: HTMLDivElement;
let fxChromaticEl: HTMLDivElement;
let shakeMag = 0; // pixels of max jitter, decays per frame
const lastHpById = new Map<string, number>();
const lastTrailTimeById = new Map<string, number>();
const lastPosById = new Map<string, { x: number; y: number }>();
let lastScoreSelf = 0;
let lastSharkNameSelf = '';

// HP Bar elements
let hpFillEl: HTMLDivElement | null = null;
let hpTextEl: HTMLSpanElement | null = null;
let hpStatusEl: HTMLSpanElement | null = null;

// Particle pool for performance - OPTIMIZED
const MAX_PARTICLES = 30; // Reduced from 50
let activeParticles = 0;


function addScreenShake(intensity: number) {
  if (!FX.damageShake) return;
  shakeMag = Math.min(12, shakeMag + Math.max(0, intensity));
}
function pulseVignette() {
  if (!FX.redVignette || !fxVignetteEl) return;
  fxVignetteEl.classList.add('active');
  setTimeout(() => fxVignetteEl.classList.remove('active'), 220);
}
function updateCriticalOverlay(curHp: number) {
  if (!fxCriticalEl) return;
  if (FX.criticalBlur && curHp <= 20) fxCriticalEl.classList.add('active');
  else fxCriticalEl.classList.remove('active');

  // Update chromatic aberration for low HP
  if (fxChromaticEl) {
    if (curHp <= 25) fxChromaticEl.classList.add('active');
    else fxChromaticEl.classList.remove('active');
  }
}

// Update HP bar in HUD
function updateHPBar(hp: number) {
  if (!hpFillEl || !hpTextEl || !hpStatusEl) return;

  const hpPercent = Math.max(0, Math.min(100, hp));
  hpFillEl.style.width = `${hpPercent}%`;
  hpTextEl.textContent = Math.round(hpPercent).toString();

  // Update status text and colors
  let status = 'Healthy';
  let statusClass = 'healthy';

  if (hpPercent <= 15) {
    status = 'Critical';
    statusClass = 'critical';
  } else if (hpPercent <= 35) {
    status = 'Injured';
    statusClass = 'injured';
  } else if (hpPercent <= 60) {
    status = 'Hurt';
    statusClass = 'injured';
  } else if (hpPercent <= 85) {
    status = 'Good';
    statusClass = 'healthy';
  }

  hpStatusEl.textContent = status;

  // Update classes
  hpFillEl.className = `hpbar__fill ${statusClass}`;
  hpStatusEl.className = `hpbar__status ${statusClass}`;
}

// Spawn particle effect
function spawnParticle(x: number, y: number, type: 'ambient' | 'evolution' | 'sparkle' | 'impact', tx = 0, ty = 0) {
  if (!fxParticlesEl || activeParticles >= MAX_PARTICLES) return;

  activeParticles++;
  const el = document.createElement('div');
  el.className = `particle particle-${type}`;

  const size = type === 'ambient' ? 8 + Math.random() * 12 :
               type === 'evolution' ? 6 + Math.random() * 10 :
               type === 'sparkle' ? 4 + Math.random() * 6 :
               5 + Math.random() * 8;

  el.style.width = `${size}px`;
  el.style.height = `${size}px`;
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;

  if (type !== 'ambient') {
    el.style.setProperty('--tx', `${tx}px`);
    el.style.setProperty('--ty', `${ty}px`);
  }

  fxParticlesEl.appendChild(el);

  const duration = type === 'ambient' ? 8000 :
                   type === 'evolution' ? 1200 :
                   type === 'sparkle' ? 800 : 600;

  setTimeout(() => {
    el.remove();
    activeParticles--;
  }, duration);
}

// Spawn evolution burst effect
function spawnEvolutionBurst(x: number, y: number) {
  // Create screen flash
  const flash = document.createElement('div');
  flash.className = 'evolution-flash';
  document.getElementById('game')?.appendChild(flash);
  setTimeout(() => flash.remove(), 800);

  // Spawn burst particles
  const particleCount = 30;
  for (let i = 0; i < particleCount; i++) {
    const angle = (Math.PI * 2 * i) / particleCount;
    const distance = 80 + Math.random() * 120;
    const tx = Math.cos(angle) * distance;
    const ty = Math.sin(angle) * distance;

    setTimeout(() => {
      spawnParticle(x, y, 'evolution', tx, ty);
    }, i * 15);
  }

  // Spawn sparkles - OPTIMIZED: reduced count from 20 to 8
  for (let i = 0; i < 8; i++) {
    const angle = Math.random() * Math.PI * 2;
    const distance = 40 + Math.random() * 80;
    const tx = Math.cos(angle) * distance;
    const ty = Math.sin(angle) * distance;

    setTimeout(() => {
      spawnParticle(x, y, 'sparkle', tx, ty);
    }, i * 40); // Increased delay spacing
  }
}
function spawnRipple(x: number, y: number, size = 37) { // 2/3 of 56px = ~37px
  if (!FX.waterRipples || activeRipples >= MAX_RIPPLES) return;
  activeRipples++;
  const el = document.createElement('div');
  el.className = 'ripple';
  el.style.width = `${size}px`; el.style.height = `${size}px`;
  el.style.left = `${x}px`; el.style.top = `${y}px`;
  world.appendChild(el);
  setTimeout(() => { el.remove(); activeRipples--; }, 450);
}
function markSharkHit(id: string) {
  if (!FX.impactFlash) return;
  const el = document.getElementById(`p-${id}`) as HTMLDivElement | null;
  if (!el) return;
  el.classList.add('shark--hit');
  setTimeout(() => el.classList.remove('shark--hit'), 140);
}
function spawnTrailBubbleAt(x: number, y: number, angle: number, sharkType?: string, velocity?: number) {
  if (!FX.waterTrail || activeTrailBubbles >= MAX_TRAIL_BUBBLES) return;

  const key = sharkType || 'Baby Shark.png';
  const s = sharkScales.get(key) || 1;

  // Fixed size scaling: bubble size scales proportionally with shark size
  const bubbleSize = s; // Direct proportional scaling with shark evolution

  // World-space tail position: center minus facing direction vector
  const cx = x + SHARK_HALF * s;
  const cy = y + SHARK_HALF * s;
  const tailDistance = SHARK_HALF * s * 0.85; // 85% of half-size behind center
  const baseTailX = cx - Math.cos(angle) * tailDistance;
  const baseTailY = cy - Math.sin(angle) * tailDistance;

  // Spawn a single bubble with slight perpendicular offset for natural variation
  if (activeTrailBubbles >= MAX_TRAIL_BUBBLES) return;

  activeTrailBubbles++;
  const el = document.createElement('div');
  el.className = 'trail-bubble';

  // Perpendicular width jitter
  const perpAngle = angle + Math.PI / 2; // perpendicular to movement
  const perpOffset = (Math.random() - 0.5) * SHARK_SIZE * s * 0.12; // ±12% of shark size
  const ax = baseTailX + Math.cos(perpAngle) * perpOffset;
  const ay = baseTailY + Math.sin(perpAngle) * perpOffset;

  // Size: keep original bubble size (no upscaling)
  const sizeMult = bubbleSize; // original behavior
  const bubbleHalfSize = 5.5 * sizeMult; // 11px * sizeMult / 2
  el.style.setProperty('--x', `${Math.round(ax - bubbleHalfSize)}px`);
  el.style.setProperty('--y', `${Math.round(ay - bubbleHalfSize)}px`);
  el.style.setProperty('--size-mult', `${sizeMult}`);

  // Velocity-based animation speed with slight variation
  const vel = velocity || 0;
  const baseAnimDuration = vel > 6 ? 700 : 900;
  const animDuration = baseAnimDuration + (Math.random() * 100 - 50); // ±50ms variation
  el.style.animationDuration = `${animDuration}ms`;

  world.appendChild(el);
  setTimeout(() => { el.remove(); activeTrailBubbles--; }, animDuration);

  // Wake effect for fast movement (velocity > 6) - OPTIMIZED: reduced probability
  if (vel > 8 && Math.random() < 0.08) { // Reduced from 30% to 8%, increased velocity threshold
    spawnWakeEffect(x, y, angle, sharkType);
  }
}

// Wake effect for fast movement
function spawnWakeEffect(x: number, y: number, angle: number, sharkType?: string) {
  const el = document.createElement('div');
  el.className = 'wake-effect';

  const key = sharkType || 'Baby Shark.png';
  const s = sharkScales.get(key) || 1;

  // Position at shark center
  const cx = x + SHARK_HALF * s;
  const cy = y + SHARK_HALF * s;

  el.style.left = `${cx}px`;
  el.style.top = `${cy}px`;
  el.style.setProperty('--angle', `${angle}rad`);

  world.appendChild(el);
  setTimeout(() => el.remove(), 600);
}

// Spawn shield pop effect (cyan bubble burst)
function spawnShieldPopEffect(x: number, y: number, s: number = 1) {
  const centerX = x;
  const centerY = y;

  // Central burst: expanding cyan ring
  const burst = document.createElement('div');
  burst.className = 'shield-pop-burst';
  const burstSize = Math.round(SHARK_SIZE * 1.2 * s);
  burst.style.width = `${burstSize}px`;
  burst.style.height = `${burstSize}px`;
  burst.style.left = `${centerX - burstSize / 2}px`;
  burst.style.top = `${centerY - burstSize / 2}px`;
  world.appendChild(burst);
  setTimeout(() => burst.remove(), 400);

  // Radial cyan particles
  const numParticles = 12;
  for (let i = 0; i < numParticles; i++) {
    const particle = document.createElement('div');
    particle.className = 'shield-pop-particle';

    const angle = (Math.PI * 2 * i) / numParticles + (Math.random() - 0.5) * 0.3;
    const speed = 30 + Math.random() * 25;
    const offsetX = Math.cos(angle) * speed;
    const offsetY = Math.sin(angle) * speed;

    const size = (12 + Math.random() * 12) * (0.85 + 0.15 * s);
    particle.style.width = `${size}px`;
    particle.style.height = `${size}px`;
    particle.style.left = `${centerX - size / 2}px`;
    particle.style.top = `${centerY - size / 2}px`;
    particle.style.setProperty('--tx', `${offsetX}px`);
    particle.style.setProperty('--ty', `${offsetY}px`);

    world.appendChild(particle);
    setTimeout(() => particle.remove(), 500);
  }
}

// Spawn evolution smoke particle explosion (Enhanced with cyan-purple gradient and sparkles)
function spawnEvolutionSmoke(x: number, y: number, s: number = 1) {
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

  // Enhanced radial particles - OPTIMIZED: reduced from 24-32 to 12-16 particles
  const numParticles = 12 + Math.floor(Math.random() * 5); // 12-16 particles
  for (let i = 0; i < numParticles; i++) {
    const particle = document.createElement('div');

    // Varied particle types: smoke (70%), sparkles (30%)
    const isSparkle = Math.random() < 0.3;
    particle.className = isSparkle ? 'evolution-sparkle' : 'evolution-smoke';

    // Random angle for radial spread
    const angle = (Math.PI * 2 * i) / numParticles + (Math.random() - 0.5) * 0.4;
    const speed = 42 + Math.random() * 34; // ~42-76px spread
    const offsetX = Math.cos(angle) * speed;
    const offsetY = Math.sin(angle) * speed;

    // Random size variation
    const size = isSparkle
      ? (8 + Math.random() * 8) * (0.85 + 0.15 * s) // Smaller sparkles
      : (18 + Math.random() * 18) * (0.85 + 0.15 * s); // Larger smoke
    particle.style.width = `${size}px`;
    particle.style.height = `${size}px`;

    // Set initial position at shark center
    particle.style.left = `${centerX - size / 2}px`;
    particle.style.top = `${centerY - size / 2}px`;

    // Use CSS variables for animation
    particle.style.setProperty('--offset-x', `${offsetX}px`);
    particle.style.setProperty('--offset-y', `${offsetY}px`);
    particle.style.setProperty('--rotation', `${Math.random() * 360}deg`);

    // Cyan to purple gradient based on particle index
    const colorProgress = i / numParticles;
    particle.style.setProperty('--color-progress', `${colorProgress}`);

    // Staggered timing for more dynamic effect
    const delay = Math.random() * 100; // 0-100ms delay
    particle.style.animationDelay = `${delay}ms`;

    world.appendChild(particle);

    // Remove after animation completes (accounting for delay)
    const duration = isSparkle ? 650 : 750;
    setTimeout(() => particle.remove(), duration + delay);
  }

  // Add secondary ring of sparkles for extra flair - OPTIMIZED: reduced from 12 to 6
  const numSparkles = 6;
  for (let i = 0; i < numSparkles; i++) {
    const sparkle = document.createElement('div');
    sparkle.className = 'evolution-sparkle evolution-sparkle--outer';

    const angle = (Math.PI * 2 * i) / numSparkles;
    const speed = 60 + Math.random() * 30; // Outer ring
    const offsetX = Math.cos(angle) * speed;
    const offsetY = Math.sin(angle) * speed;

    const size = (6 + Math.random() * 6) * (0.85 + 0.15 * s);
    sparkle.style.width = `${size}px`;
    sparkle.style.height = `${size}px`;
    sparkle.style.left = `${centerX - size / 2}px`;
    sparkle.style.top = `${centerY - size / 2}px`;

    sparkle.style.setProperty('--offset-x', `${offsetX}px`);
    sparkle.style.setProperty('--offset-y', `${offsetY}px`);
    sparkle.style.setProperty('--rotation', `${Math.random() * 360}deg`);

    const delay = 50 + Math.random() * 100; // Slightly delayed
    sparkle.style.animationDelay = `${delay}ms`;

    world.appendChild(sparkle);
    setTimeout(() => sparkle.remove(), 700 + delay);
  }
}
function spawnScorePopup(playerId: string, delta: number) {
  if (!FX.scorePopup || activeScorePopups >= MAX_SCORE_POPUPS || !selfId) return;
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
    if (idx !== -1) activeScorePopupEls.splice(idx, 1);
  }, 800);
}

// Spawn death particles and trigger death animation (Enhanced with color transitions and debris)
function triggerDeathAnimation(playerId: string) {
  const p = players[playerId];
  if (!p) return;

  const el = document.getElementById(`p-${playerId}`) as HTMLDivElement | null;
  if (!el) return;

  // Set CSS variables for death animation (capture current position)
  el.style.setProperty('--death-x', `${Math.round(p.x)}px`);
  el.style.setProperty('--death-y', `${Math.round(p.y)}px`);

  const imgEl = el.querySelector('.shark__img') as HTMLDivElement | null;
  if (imgEl) {
    const currentTransform = imgEl.style.transform || '';
    const angleMatch = currentTransform.match(/rotate\(([^)]+)\)/);
    const flipMatch = currentTransform.match(/scaleY\(([^)]+)\)/);
    const angle = angleMatch ? angleMatch[1] : '0rad';
    const flip = flipMatch ? flipMatch[1] : '1';
    el.style.setProperty('--death-angle', angle);
    el.style.setProperty('--death-flip', flip);
  }

  // Enhanced death particles - OPTIMIZED: reduced from 24 to 12 particles
  const cx = p.x + SHARK_HALF;
  const cy = p.y + SHARK_HALF;
  const numParticles = 12;

  for (let i = 0; i < numParticles; i++) {
    const particle = document.createElement('div');

    // Mix of particle types: energy particles (60%), debris (40%)
    const isDebris = Math.random() < 0.4;
    particle.className = isDebris ? 'death-debris' : 'death-particle';

    // Varied trajectories - some go far, some stay close
    const angle = (i / numParticles) * Math.PI * 2 + (Math.random() - 0.5) * 0.5;
    const dist = isDebris
      ? 30 + Math.random() * 40 // Debris doesn't travel as far
      : 40 + Math.random() * 60; // Energy particles travel further

    const px = Math.cos(angle) * dist;
    const py = Math.sin(angle) * dist;

    // Add gravity effect to some particles
    const gravity = isDebris ? 20 + Math.random() * 20 : 0;

    particle.style.setProperty('--px', `${px}px`);
    particle.style.setProperty('--py', `${py + gravity}px`);
    particle.style.setProperty('--gravity', `${gravity}px`);

    // Color transition progress (cyan → red → fade)
    const colorPhase = i / numParticles;
    particle.style.setProperty('--color-phase', `${colorPhase}`);

    // Size variation
    const size = isDebris
      ? 4 + Math.random() * 4 // 4-8px debris
      : 5 + Math.random() * 3; // 5-8px energy
    particle.style.width = `${size}px`;
    particle.style.height = `${size}px`;

    particle.style.left = `${cx}px`;
    particle.style.top = `${cy}px`;

    // Staggered timing for more dynamic effect
    const delay = Math.random() * 80;
    particle.style.animationDelay = `${delay}ms`;

    world.appendChild(particle);
    setTimeout(() => particle.remove(), 1000 + delay);
  }

  // Multiple impact ripples with staggered timing - OPTIMIZED: reduced from 3 to 2 ripples
  spawnRipple(Math.round(cx), Math.round(cy), 80); // Initial large ripple
  setTimeout(() => spawnRipple(Math.round(cx), Math.round(cy), 50), 120); // Secondary ripple

  // Spawn additional energy burst particles - OPTIMIZED: reduced from 8 to 4
  for (let i = 0; i < 4; i++) {
    const burst = document.createElement('div');
    burst.className = 'death-energy-burst';

    const angle = (i / 8) * Math.PI * 2;
    const speed = 50 + Math.random() * 30;
    const offsetX = Math.cos(angle) * speed;
    const offsetY = Math.sin(angle) * speed;

    burst.style.setProperty('--offset-x', `${offsetX}px`);
    burst.style.setProperty('--offset-y', `${offsetY}px`);
    burst.style.left = `${cx}px`;
    burst.style.top = `${cy}px`;

    world.appendChild(burst);
    setTimeout(() => burst.remove(), 800);
  }

  // Note: Shark element will be removed by server's 'player:left' event after 1.2s
  // This matches the death animation duration
}

function screenToWorld(cx: number, cy: number): { x: number; y: number } {
  return { x: (cx - camera.x) / CAMERA_ZOOM, y: (cy - camera.y) / CAMERA_ZOOM };
}

function emitShootAtClientCoords(cx: number, cy: number) {
  if (!socket) return;
  const w = screenToWorld(cx, cy);
  socket.emit('player:shoot', { tx: w.x, ty: w.y });
}

// Hold-to-fire support with client-side throttle aligned to server cooldown
let fireHeld = false;
let fireTimer: number | null = null;
let lastClientShotAt = 0;
const CLIENT_COOLDOWN_MS = 500;

function aimCoords(): { cx: number; cy: number } {
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
  if (fireHeld) return;
  fireHeld = true;
  tryFireOnce(); // Fire immediately

  // Use requestAnimationFrame loop instead of setInterval for more precise timing
  if (fireTimer !== null) { cancelAnimationFrame(fireTimer); }

  const fireLoop = () => {
    if (!fireHeld) return;
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
function updateProjectiles(updates: Array<{ id: number; x: number; y: number }>) {
  if (!projectileLayer) return;
  const seen = new Set<number>();
  for (const u of updates) {
    seen.add(u.id);
    let el = document.getElementById(`proj-${u.id}`) as HTMLDivElement | null;
    if (!el) {
      el = document.createElement('div');
      el.id = `proj-${u.id}`;
      el.className = 'projectile';
      projectileLayer.appendChild(el);
    } else {
      el.classList.remove('out');
    }
    const x = Math.round(u.x - PROJ_W / 2);
    const y = Math.round(u.y - PROJ_H / 2);
    el.style.transform = `translate3d(${x}px, ${y}px, 0)`;
    // Track last known world position for impact ripples
    projectiles[u.id] = { x: u.x, y: u.y };
  }
  const children = Array.from(projectileLayer.children) as HTMLDivElement[];
  for (const el of children) {
    const idStr = el.id.startsWith('proj-') ? el.id.slice(5) : '';
    const id = Number(idStr);
    if (!seen.has(id)) {
      if (!el.classList.contains('out')) {
        const pos = projectiles[id];
        if (pos) spawnRipple(Math.round(pos.x), Math.round(pos.y), 28); // 2/3 of 42px = 28px
        // Remove bullet instantly on contact (no fade delay)
        el.remove();
      }
      delete projectiles[id];
    }
  }
}



let bubbleLayer: HTMLElement;
let posXEl: HTMLElement;
let posYEl: HTMLElement;
let minimap: HTMLCanvasElement;
let ctx: CanvasRenderingContext2D;
let lastFrame = performance.now();
let mouse: { x: number; y: number } | null = null;
let lastMinimapMs = 0;
let lastEatCheckMs = 0;

let camera = { x: -MAP_SIZE / 2, y: -MAP_SIZE / 2 };


// Performance + UI refs
let fpsEMA = 0; let msEMA = 0;
let fpsEl: HTMLElement; let msEl: HTMLElement; let lbEl: HTMLDivElement;
let lbHTMLCache = "";


let cameraTicker: number | null = null;
const SELF_POS_LOG_CAP = 5000;
const selfPosLog: Array<{ t: number; x: number; y: number } | undefined> = new Array(SELF_POS_LOG_CAP);
let selfPosLogIdx = 0;

function startCameraTicker() {
  // Disabled ultra-high-frequency ticker to avoid CPU spikes; camera is updated in render()
  if (cameraTicker !== null) { clearInterval(cameraTicker); cameraTicker = null; }

}

// Game entities

let pingTimer: number | null = null;

type Food = { id: number; x: number; y: number };
let foods: Record<number, Food> = {};
// Temporary bite animation window per player id
const biteUntil = new Map<string, number>();
const foodEls: Map<number, HTMLDivElement> = new Map();

let throttleAt = 0;

// Keyboard state for WASD movement
let keys = { w: false, a: false, s: false, d: false };

// Pixel-perfect collision assets and helpers
let imagesReady = false;
let sharkAlpha: Uint8ClampedArray | null = null;
let foodAlpha: Uint8ClampedArray | null = null;
let foodAlphaSize = FISHFOOD_SIZE; // width/height of pre-rendered food alpha map
// Tail anchor (in sprite local coordinates, origin = top-left of 256x256)
let tailAnchor: { x: number; y: number } | null = null;
// Tail offsets per shark type (from server, in mask space relative to center)
const sharkTailOffsets = new Map<string, { x: number; y: number }>();
// Visual scale per shark type (from server)
const sharkScales = new Map<string, number>();
// Evolution visual hold: delay sprite swap until smoke covers shark
const evolutionPrevSharkType = new Map<string, string>();
const evolutionHoldUntil = new Map<string, number>();

// Collision masks for visualization (debug mode)
const sharkMasks = new Map<string, Uint8Array>();
let maskSize = 256;
let showCollisionMasks = false; // Toggle with 'M' key

function computeTailAnchorFromAlpha(alpha: Uint8ClampedArray, size: number): { x: number; y: number } {
  const A = (x: number, y: number) => alpha[(y * size + x) * 4 + 3];
  let maxX = -1;
  const rightmost: number[] = new Array(size).fill(-1);
  for (let y = 0; y < size; y++) {
    for (let x = size - 1; x >= 0; x--) {
      if (A(x, y) > 10) { rightmost[y] = x; if (x > maxX) maxX = x; break; }
    }
  }
  if (maxX < 0) return { x: Math.round(size * 0.85), y: Math.round(size / 2) };
  // Average y among rows that hit near the extreme right (within 2px) to find tail midline
  let sumY = 0, cnt = 0;
  for (let y = 0; y < size; y++) { if (rightmost[y] >= maxX - 2) { sumY += y; cnt++; } }
  const yMid = cnt ? Math.round(sumY / cnt) : Math.round(size / 2);
  return { x: maxX, y: yMid };
}

// Densely sample the rightmost opaque edge rows to represent the tail surface
let tailEdge: Array<{ x: number; y: number }> | null = null;
function computeTailEdgeFromAlpha(alpha: Uint8ClampedArray, size: number): Array<{ x: number; y: number }> {
  const A = (x: number, y: number) => alpha[(y * size + x) * 4 + 3];
  let maxX = -1;
  const rightmost: number[] = new Array(size).fill(-1);
  for (let y = 0; y < size; y++) {
    for (let x = size - 1; x >= 0; x--) {
      if (A(x, y) > 10) { rightmost[y] = x; if (x > maxX) maxX = x; break; }
    }
  }
  const pts: Array<{ x: number; y: number }> = [];
  if (maxX >= 0) {
    for (let y = 0; y < size; y++) {
      const rx = rightmost[y];
      if (rx >= maxX - 2 && rx >= 0) pts.push({ x: rx, y });
    }
  }
  // Thin out to reduce overdraw while keeping good coverage
  if (pts.length > 60) {
    const thin: Array<{ x: number; y: number }> = [];
    const step = Math.max(1, Math.floor(pts.length / 40));
    for (let i = 0; i < pts.length; i += step) thin.push(pts[i]);
    return thin;
  }
  return pts;
}

function loadCollisionMaps(): Promise<void> {
  return new Promise((resolve) => {
    let loaded = 0;
    const done = () => { if (++loaded === 2) { imagesReady = true; resolve(); } };

    // Shark (256x256). Generate mask from PNG alpha channel
    (async () => {
      const sharkImg = new Image();
      sharkImg.src = '/sharks/Baby%20Shark.png';
      sharkImg.onload = () => {
        // Use SHARK_MASK_SIZE (256) for collision detection, not render size
        const c = document.createElement('canvas');
        c.width = SHARK_MASK_SIZE;
        c.height = SHARK_MASK_SIZE;
        const cctx = c.getContext('2d')!;
        cctx.clearRect(0, 0, SHARK_MASK_SIZE, SHARK_MASK_SIZE);
        const nw = sharkImg.naturalWidth || sharkImg.width;
        const nh = sharkImg.naturalHeight || sharkImg.height;
        const scale = Math.max(SHARK_MASK_SIZE / nw, SHARK_MASK_SIZE / nh); // cover
        const dw = nw * scale, dh = nh * scale;
        const dx = (SHARK_MASK_SIZE - dw) / 2, dy = (SHARK_MASK_SIZE - dh) / 2; // centered
        cctx.drawImage(sharkImg, dx, dy, dw, dh);
        sharkAlpha = cctx.getImageData(0, 0, SHARK_MASK_SIZE, SHARK_MASK_SIZE).data; // RGBA
        // Compute tail anchor + edge from image alpha
        tailAnchor = computeTailAnchorFromAlpha(sharkAlpha, SHARK_MASK_SIZE);
        tailEdge = computeTailEdgeFromAlpha(sharkAlpha, SHARK_MASK_SIZE);
        console.log('✓ Generated shark mask from PNG alpha channel');
        done();
      };
      sharkImg.onerror = () => {
        console.error('✗ Failed to load Baby Shark.png');
        done();
      };
    })();

    // Food alpha: generate mask from PNG alpha channel
    (async () => {
      const target = FISHFOOD_SIZE;
      const foodImg = new Image();
      foodImg.src = '/food/FishFood.png';
      foodImg.onload = () => {
        // Load at 64x64 then scale to target size
        const srcW = 64, srcH = 64;
        const srcCanvas = document.createElement('canvas');
        srcCanvas.width = srcW;
        srcCanvas.height = srcH;
        const sctx = srcCanvas.getContext('2d')!;
        sctx.clearRect(0, 0, srcW, srcH);
        sctx.drawImage(foodImg, 0, 0, srcW, srcH);

        // Scale to target size
        const dstCanvas = document.createElement('canvas');
        dstCanvas.width = target;
        dstCanvas.height = target;
        const dctx = dstCanvas.getContext('2d')!;
        dctx.clearRect(0, 0, target, target);
        // Use nearest-neighbor scaling for crisp mask
        (dctx as any).imageSmoothingEnabled = false;
        dctx.drawImage(srcCanvas, 0, 0, target, target);
        const id = dctx.getImageData(0, 0, target, target);
        foodAlpha = id.data;
        foodAlphaSize = target;
        console.log('✓ Generated food mask from PNG alpha channel');
        done();
      };
      foodImg.onerror = () => {
        console.error('✗ Failed to load FishFood.png, using fallback circle');
        // Fallback: procedural circle
        const s = target;
        const c = document.createElement('canvas');
        c.width = s;
        c.height = s;
        const cctx = c.getContext('2d')!;
        cctx.clearRect(0, 0, s, s);
        cctx.beginPath();
        cctx.arc(s / 2, s / 2, s / 2, 0, Math.PI * 2);
        cctx.fillStyle = '#ffffff';
        cctx.fill();
        foodAlpha = cctx.getImageData(0, 0, s, s).data;
        foodAlphaSize = s;
        done();
      };
    })();
  });
}

// Per-food send throttle to avoid spamming yet allow rapid retries during movement
const lastEatEmit = new Map<number, number>();

function requestEat(foodId: number) {
  if (!socket) return;
  const now = performance.now();
  const last = lastEatEmit.get(foodId) || 0;
  if (now - last < 70) return; // at most ~14 emits/sec per food while overlapping
  lastEatEmit.set(foodId, now);
  socket.volatile.emit('player:eat', foodId);
}

function pixelPerfectHit(me: Player, food: Food): boolean {
  if (!imagesReady || !sharkAlpha || !foodAlpha) return false;
  // Respect per-shark visual scale (evolution sizing)
  const key = me.sharkType || 'Baby Shark.png';
  const s = sharkScales.get(key) || 1;

  // Quick circle check first (slightly more forgiving)
  const cx = me.x + SHARK_HALF * s, cy = me.y + SHARK_HALF * s;
  const dx = cx - food.x, dy = cy - food.y;
  const maxDist = SHARK_HALF * s + FOOD_RADIUS + 20; // increased tolerance
  if ((dx*dx + dy*dy) > (maxDist*maxDist)) return false;

  const rot = me.angle + Math.PI;
  const cos = Math.cos(rot), sin = Math.sin(rot);

  const sSize = SHARK_MASK_SIZE; // Use mask size (256)
  const fSize = foodAlphaSize;
  const halfF = FOOD_RADIUS;

  const sampleShark = (sx: number, sy: number) => {
    if (sx < 0 || sy < 0 || sx >= sSize || sy >= sSize) return 0;
    const data = sharkAlpha!; return data[(sy * sSize + sx) * 4 + 3];
  };

  // Iterate food opaque pixels and map into shark local space
  for (let fy = 0; fy < fSize; fy++) {
    for (let fx = 0; fx < fSize; fx++) {
      const fa = foodAlpha[(fy * fSize + fx) * 4 + 3];
      if (fa === 0) continue; // transparent food pixel
      // world position of this food pixel (treat each pixel center)
      const wx = food.x - halfF + fx + 0.5;
      const wy = food.y - halfF + fy + 0.5;
      // vector from shark center (in render space)
      const vx = wx - cx; const vy = wy - cy;
      // rotate by -rot: x' = x cos + y sin ; y' = -x sin + y cos
      const lx = vx * cos + vy * sin;
      const ly = -vx * sin + vy * cos;
      // Scale to mask space using visual scale
      const scale = SHARK_SCALE * s;
      const sx = Math.round((lx / scale) + sSize / 2);
      const sy = Math.round((ly / scale) + sSize / 2);
      // 5x5 neighborhood for better collision detection with scaled sprites
      for (let oy = -2; oy <= 2; oy++) {
        for (let ox = -2; ox <= 2; ox++) {
          const sa = sampleShark(sx + ox, sy + oy);
          if (sa !== 0) return true; // colored pixel overlap
        }
      }
    }
  }
  return false;
}

function checkEatCollisions() {
  if (!socket || !selfId) return;
  const me = players[selfId]; if (!me) return;
  const key = me.sharkType || 'Baby Shark.png';
  const s = sharkScales.get(key) || 1;
  for (const f of Object.values(foods)) {
    // coarse range filter with visual scale
    const dx = (me.x + SHARK_HALF * s) - f.x; const dy = (me.y + SHARK_HALF * s) - f.y;
    const maxR = SHARK_HALF * s + FOOD_RADIUS + 16;
    if ((dx*dx + dy*dy) > (maxR*maxR)) continue;
    if (pixelPerfectHit(me, f)) {
      requestEat(f.id);
    }
  }
}


// Auth/UI elements
let btnLogin: HTMLButtonElement;
let btnSignup: HTMLButtonElement;
let accountChip: HTMLDivElement;
let accountName: HTMLElement;
let accountMenu: HTMLDivElement;
let menuLogout: HTMLButtonElement;
let menuReset: HTMLButtonElement;

// Modals and inputs
let modalSignup: HTMLDivElement, suUser: HTMLInputElement, suPass: HTMLInputElement, suErrors: HTMLElement, suCancel: HTMLButtonElement, suSubmit: HTMLButtonElement;
let modalLogin: HTMLDivElement, liUser: HTMLInputElement, liPass: HTMLInputElement, liErrors: HTMLElement, liCancel: HTMLButtonElement, liSubmit: HTMLButtonElement;
let modalReset: HTMLDivElement, rpPass: HTMLInputElement, rpConfirm: HTMLInputElement, rpErrors: HTMLElement, rpCancel: HTMLButtonElement, rpSubmit: HTMLButtonElement;
let modalProfile: HTMLDivElement, profileClose: HTMLButtonElement;
let suStrengthFill: HTMLElement, suStrengthText: HTMLElement;
let rpStrengthFill: HTMLElement, rpStrengthText: HTMLElement;
let menuProfile: HTMLButtonElement;

type Session = { username: string; timeCreated: string };
const API_BASE = '';

function hashPassword(password: string): string {
  return btoa(password + 'jawz_salt');
}

function validatePassword(password: string): { isValid: boolean; errors: string[]; strength: 'weak' | 'medium' | 'strong' } {
  const errors: string[] = [];
  if (password.length < 6) errors.push('Password must be at least 6 characters');
  if (!/\d/.test(password)) errors.push('Password must include at least 1 number');

  // Calculate strength
  let strength: 'weak' | 'medium' | 'strong' = 'weak';
  if (password.length >= 8 && /[A-Z]/.test(password) && /[a-z]/.test(password) && /\d/.test(password)) {
    strength = 'strong';
  } else if (password.length >= 6 && /\d/.test(password)) {
    strength = 'medium';
  }

  return { isValid: errors.length === 0, errors, strength };
}

function updatePasswordStrength(password: string, fillEl: HTMLElement, textEl: HTMLElement) {
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

function getSession(): Session | null {
  try { const s = localStorage.getItem('jawz_user'); return s ? JSON.parse(s) : null; } catch { return null; }
}
function setSession(s: Session) { localStorage.setItem('jawz_user', JSON.stringify(s)); }
function clearSession() { localStorage.removeItem('jawz_user'); }

function openModal(el: HTMLElement) { el.classList.remove('hidden'); }
function closeModal(el: HTMLElement) { el.classList.add('hidden'); }

function showLoading(text: string) {
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

async function signup(username: string, password: string): Promise<{ ok: boolean; error?: string; data?: Session }>{
  const v = validatePassword(password);
  if (!v.isValid) return { ok: false, error: v.errors.join('\n') };
  const res = await fetch(`${API_BASE}/api/users`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: hashPassword(password), timeCreated: new Date().toISOString() })
  });
  if (res.status === 409) return { ok: false, error: 'Username already exists' };
  if (!res.ok) return { ok: false, error: 'Sign up failed' };
  const data = await res.json();
  return { ok: true, data };
}

async function login(username: string, password: string): Promise<{ ok: boolean; error?: string; data?: Session }>{
  const res = await fetch(`${API_BASE}/api/users`);
  if (!res.ok) return { ok: false, error: 'Login failed' };
  const users: Array<{ username: string; password: string; timeCreated: string }> = await res.json();
  const found = users.find(u => u.username === username);
  if (!found) return { ok: false, error: 'User not found' };
  if (found.password !== hashPassword(password)) return { ok: false, error: 'Invalid password' };
  return { ok: true, data: { username: found.username, timeCreated: found.timeCreated } };
}

async function resetPassword(newPassword: string): Promise<{ ok: boolean; error?: string }>{
  const s = getSession(); if (!s) return { ok: false, error: 'Not logged in' };
  const v = validatePassword(newPassword);
  if (!v.isValid) return { ok: false, error: v.errors.join('\n') };
  const res = await fetch(`${API_BASE}/api/users/${encodeURIComponent(s.username)}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: hashPassword(newPassword) })
  });
  if (!res.ok) return { ok: false, error: 'Update failed' };
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
    const input = document.getElementById('username') as HTMLInputElement;
    if (input) input.value = s.username;
    // Ensure account menu closed
    accountChip.setAttribute('aria-expanded', 'false');
    if (accountMenu) accountMenu.classList.add('hidden');
  } else {
    btnLogin.classList.remove('hidden');
    btnSignup.classList.remove('hidden');
    accountChip.classList.add('hidden');
    accountName.textContent = '';
    accountChip.setAttribute('aria-expanded', 'false');
    if (accountMenu) accountMenu.classList.add('hidden');
    const input = document.getElementById('username') as HTMLInputElement | null;
    if (input) input.value = '';
  }
}

function createBubbleLayer(n = 12) {  // Reduced from 24 to 12 for better performance
  for (let i = 0; i < n; i++) {
    const b = document.createElement('img');
    b.className = 'bubble';
    (b as HTMLImageElement).src = '/props/bubble.png.png';
    (b as HTMLImageElement).alt = 'bubble';
    // Explicit dimensions both as CSS and HTML attributes to avoid runtime resampling
    (b as HTMLImageElement).width = DECOR_BUBBLE_SIZE;
    (b as HTMLImageElement).height = DECOR_BUBBLE_SIZE;
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
  if (!selfId) return;
  const self = players[selfId];
  if (!self) return;

  // Compute CSS-pixel offsets so the shark center is exactly at the viewport center
  const z = CAMERA_ZOOM;
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  // Calculate desired camera position (centered on shark)
  // The shark's position (self.x, self.y) is the top-left corner in world coordinates
  // The center is at (self.x + SHARK_HALF, self.y + SHARK_HALF) regardless of visual scale
  // Visual scale is applied via CSS transform and doesn't affect world coordinates
  let cx = (vw / 2) - (self.x + SHARK_HALF) * z;
  let cy = (vh / 2) - (self.y + SHARK_HALF) * z;

  // Apply camera limits to prevent showing borders
  // The world is MAP_SIZE x MAP_SIZE, scaled by CAMERA_ZOOM
  const worldWidth = MAP_SIZE * z;
  const worldHeight = MAP_SIZE * z;

  // Clamp camera so borders are never visible
  // Camera position represents the top-left corner of the world in screen space
  // Right edge: camera.x + worldWidth >= vw (world's right edge must be at or past screen right)
  // Bottom edge: camera.y + worldHeight >= vh (world's bottom edge must be at or past screen bottom)
  const minX = vw - worldWidth;  // Most negative (left) the camera can go
  const maxX = 0;                 // Most positive (right) the camera can go
  const minY = vh - worldHeight;  // Most negative (top) the camera can go
  const maxY = 0;                 // Most positive (bottom) the camera can go

  // Only apply horizontal limits to prevent showing left/right borders
  // Allow vertical camera movement beyond world boundaries for top/bottom views
  if (worldWidth > vw) {
    cx = Math.max(minX, Math.min(maxX, cx));
  }
  // Removed vertical clamping - players can see beyond top/bottom world boundaries

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
  // Round camera position to avoid sub-pixel rendering glitches
  world.style.transform = `translate3d(${Math.round(camera.x + sx)}px, ${Math.round(camera.y + sy)}px, 0) scale(${CAMERA_ZOOM})`;
}

function ensureSharkEl(id: string, username: string) {
  let el = document.getElementById(`p-${id}`) as HTMLDivElement | null;
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

function ensureFoodEl(food: Food) {
  let el = document.getElementById(`f-${food.id}`) as HTMLDivElement | null;
  if (!el) {
    el = document.createElement('div');
    el.id = `f-${food.id}`;
    el.className = 'food';
    el.style.width = `${FISHFOOD_SIZE}px`;
    el.style.height = `${FISHFOOD_SIZE}px`;
    world.appendChild(el);
  }
  el.style.transform = `translate(${(food.x - FISHFOOD_SIZE / 2)}px, ${(food.y - FISHFOOD_SIZE / 2)}px)`;
  foodEls.set(food.id, el);
  return el;
}

function removeFoodEl(id: number) {
  const el = document.getElementById(`f-${id}`);
  if (el && el.parentElement) el.parentElement.removeChild(el);
  foodEls.delete(id);
}

function escapeHTML(s: string): string { return s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;','\'':'&#39;'}[c] as string)); }

function updateLeaderboard(entries: Array<{ id: string; username: string; score: number }>) {
  if (!lbEl) return;
  const html = entries.slice(0, 10).map((e, i) => (
    `<li class="leaderboard__item"><div class="leaderboard__rank">${i+1}</div><div class="leaderboard__name">${escapeHTML(e.username)}</div><div class="leaderboard__score">${e.score}</div></li>`
  )).join('');
  const wrapped = `<ul class=\"leaderboard__list\">${html}</ul>`;
  if (wrapped !== lbHTMLCache) {
    lbHTMLCache = wrapped;
    lbEl.innerHTML = wrapped;
  }
}

function createBubbleLayerFromSeeds(seeds: Array<{ left: number; delay: number }>) {
  if (!bubbleLayer) return;
  bubbleLayer.innerHTML = '';
  for (const s of seeds) {
    const b = document.createElement('img');
    b.className = 'bubble';
    (b as HTMLImageElement).src = '/props/bubble.png.png';
    (b as HTMLImageElement).alt = 'bubble';
    // Explicit dimensions both as CSS and HTML attributes to avoid runtime resampling
    (b as HTMLImageElement).width = DECOR_BUBBLE_SIZE;
    (b as HTMLImageElement).height = DECOR_BUBBLE_SIZE;
    b.style.width = `${DECOR_BUBBLE_SIZE}px`;
    b.style.height = `${DECOR_BUBBLE_SIZE}px`;
    b.style.left = `${s.left}%`;
    b.style.bottom = `${-Math.random() * 30}vh`;
    b.style.animationDelay = `${s.delay.toFixed(2)}s`;
    bubbleLayer.appendChild(b);
  }
}

function removeSharkEl(id: string) {
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
    } else {
      el.classList.remove('shark--dead');
      deathAnimTriggered.delete(p.id);
    }

    // Position and scale container (name/HP remain upright since rotation is on image only)
    const keyType = p.sharkType || 'Baby Shark.png';
    const s = sharkScales.get(keyType) || 1;
    // Round positions to avoid sub-pixel rendering glitches
    el.style.transform = `translate3d(${Math.round(p.x)}px, ${Math.round(p.y)}px, 0) scale(${s})`;
    if (s >= 1.32) el.classList.add('shark--apex'); else el.classList.remove('shark--apex');
    // Rotate/mirror only the shark image so the label remains upright and unflipped
    const a = p.angle;
    let deg = (a * 180 / Math.PI) % 360; if (deg < 0) deg += 360; // normalize 0..360
    const flipX = (deg > 270 || deg < 90) ? -1 : 1; // right-side quadrants => flip
    const imgEl = el.querySelector('.shark__img') as HTMLDivElement | null;
    const flashEl = el.querySelector('.shark__flash') as HTMLDivElement | null;
      const glowEl = el.querySelector('.shark__glow') as HTMLDivElement | null;
    if (imgEl) {
      // Update shark sprite based on sharkType, with optional evolution hold to let smoke cover swap
      let sharkType = p.sharkType || 'Baby Shark.png';
      const holdUntil = evolutionHoldUntil.get(p.id) || 0;
      const nowT = performance.now();
      if (nowT < holdUntil) {
        const prev = evolutionPrevSharkType.get(p.id);
        if (prev) sharkType = prev;
      } else if (holdUntil) {
        // Clear hold after it expires
        evolutionHoldUntil.delete(p.id);
        evolutionPrevSharkType.delete(p.id);
      }
      const sharkPath = `/sharks/${encodeURIComponent(sharkType)}`;
      const expectedBg = `url("${sharkPath}")`;
      // Always update to ensure correct sprite (avoid comparison issues with URL encoding)
      imgEl.style.backgroundImage = expectedBg;
      // Also update flash and glow elements to use same sprite for effects
      if (flashEl) flashEl.style.backgroundImage = expectedBg;
      if (glowEl) glowEl.style.backgroundImage = expectedBg;

      const now = performance.now();
      const baseBite = (biteUntil.get(p.id) || 0) > now ? 1.08 : 1.0;
      const biteScale = baseBite + Math.max(0, s - 1) * 0.04; // slightly stronger bite puff for bigger sharks
      const tr = `rotate(${(a + Math.PI)}rad) scaleY(${flipX}) scale(${biteScale})`;
      imgEl.style.transform = tr;
      if (flashEl) flashEl.style.transform = tr;
        if (glowEl) glowEl.style.transform = tr;

      // Collision mask visualization overlay (debug mode)
      if (showCollisionMasks) {
        let maskCanvas = el.querySelector('.shark__mask-overlay') as HTMLCanvasElement | null;
        if (!maskCanvas) {
          maskCanvas = document.createElement('canvas');
          maskCanvas.className = 'shark__mask-overlay';
          maskCanvas.width = SHARK_SIZE;
          maskCanvas.height = SHARK_SIZE;
          maskCanvas.style.cssText = `
            position: absolute;
            top: 0;
            left: 0;
            width: ${SHARK_SIZE}px;
            height: ${SHARK_SIZE}px;
            pointer-events: none;
            z-index: 100;
            opacity: 0.5;
          `;
          imgEl.parentElement?.appendChild(maskCanvas);
        }

        // Render the collision mask
        const mask = sharkMasks.get(sharkType);
        if (mask && maskCanvas) {
          const ctx = maskCanvas.getContext('2d');
          if (ctx) {
            ctx.clearRect(0, 0, SHARK_SIZE, SHARK_SIZE);

            // Create ImageData for the mask
            const imageData = ctx.createImageData(SHARK_SIZE, SHARK_SIZE);
            const data = imageData.data;

            // Scale mask to render size and apply same transform as shark
            for (let y = 0; y < SHARK_SIZE; y++) {
              for (let x = 0; x < SHARK_SIZE; x++) {
                // Map render pixel to mask pixel
                const maskX = Math.floor((x / SHARK_SIZE) * maskSize);
                const maskY = Math.floor((y / SHARK_SIZE) * maskSize);
                const maskIdx = maskY * maskSize + maskX;

                const pixelIdx = (y * SHARK_SIZE + x) * 4;
                if (mask[maskIdx] !== 0) {
                  // Opaque pixel - show in cyan
                  data[pixelIdx] = 0;       // R
                  data[pixelIdx + 1] = 255; // G
                  data[pixelIdx + 2] = 255; // B
                  data[pixelIdx + 3] = 180; // A
                } else {
                  // Transparent pixel - show in red (very faint)
                  data[pixelIdx] = 255;     // R
                  data[pixelIdx + 1] = 0;   // G
                  data[pixelIdx + 2] = 0;   // B
                  data[pixelIdx + 3] = 30;  // A (very transparent)
                }
              }
            }

            ctx.putImageData(imageData, 0, 0);

            // Apply same transform as shark image
            maskCanvas.style.transform = tr;
          }
        }
      } else {
        // Remove mask overlay if it exists
        const maskCanvas = el.querySelector('.shark__mask-overlay');
        if (maskCanvas) maskCanvas.remove();
      }
    }
    // Health bar update
    const hpEl = el.querySelector('.shark__hpFill') as HTMLDivElement | null;
    if (hpEl) {
      const cur = Math.max(0, Math.min(100, (p as any).hp ?? 100));
      hpEl.style.width = cur + '%';
      // Dynamic HP color thresholds
      if (cur < 25) {
        hpEl.style.background = 'linear-gradient(90deg, #ff6b6b, #ff5252)';
      } else if (cur < 50) {
        hpEl.style.background = 'linear-gradient(90deg, #ffd24a, #ffb02a)';
      } else {
        hpEl.style.background = 'linear-gradient(90deg, #2aff88, #14d06a)';
      }
    }

    // Bubble Shield visual effect (server-authoritative for all players)
    const hasShield = p.abilities?.bubbleShield && Date.now() < (p.abilities.bubbleShield.activeUntil || 0);

    let shieldEl = el.querySelector('.shark__shield') as HTMLDivElement | null;
    if (hasShield && !shieldEl) {
      // Create shield element
      shieldEl = document.createElement('div');
      shieldEl.className = 'shark__shield';
      // Insert before the image so it appears behind the shark
      el.insertBefore(shieldEl, el.querySelector('.shark__img'));
    } else if (!hasShield && shieldEl) {
      // Remove shield element with fade out
      shieldEl.style.opacity = '0';
      setTimeout(() => shieldEl?.remove(), 200);
    }

    // --- FX: damage detection, trail emission, critical overlay ---
    const curHp = Math.max(0, Math.min(100, (p as any).hp ?? 100));
    const prevHp = lastHpById.get(p.id) ?? curHp;
    if (p.id === selfId) {
      updateCriticalOverlay(curHp);
      updateHPBar(curHp);
    }
    if (curHp < prevHp) {
      markSharkHit(p.id);
      spawnRipple(Math.round(p.x + SHARK_HALF), Math.round(p.y + SHARK_HALF), 56);
      if (p.id === selfId) {
        addScreenShake(Math.min(10, (prevHp - curHp) * 0.25));
        pulseVignette();

        // Spawn impact particles on damage (center of screen since camera follows player)
        const screenCenterX = window.innerWidth / 2;
        const screenCenterY = window.innerHeight / 2;
        for (let i = 0; i < 5; i++) {
          const angle = Math.random() * Math.PI * 2;
          const dist = 20 + Math.random() * 30;
          setTimeout(() => {
            spawnParticle(screenCenterX, screenCenterY, 'impact', Math.cos(angle) * dist, Math.sin(angle) * dist);
          }, i * 20);
        }
      }
    }
    lastHpById.set(p.id, curHp);

    // Water trail: throttle more aggressively for performance (only when moving)
    const nowMs2 = performance.now();
    const lastT = lastTrailTimeById.get(p.id) || 0;
    const prevPos = lastPosById.get(p.id);

    // Spawn water trail bubble every 150ms while moving - OPTIMIZED from 50ms
    const trailInterval = 150;

    // Calculate velocity for velocity-based particle spawning
    let velocity = 0;
    if (prevPos) {
      const dx = p.x - prevPos.x;
      const dy = p.y - prevPos.y;
      const dt = (nowMs2 - lastT) / 1000; // Convert to seconds
      velocity = dt > 0 ? Math.sqrt(dx * dx + dy * dy) / dt : 0;
    }

    // Spawn one bubble every 150ms when moving - OPTIMIZED from 50ms for better FPS
    if (nowMs2 - lastT > trailInterval && prevPos && (Math.abs(prevPos.x - p.x) + Math.abs(prevPos.y - p.y) > 2)) {
      spawnTrailBubbleAt(p.x, p.y, p.angle, p.sharkType, velocity);
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
      } else if (topScore > 0) {
        pct = Math.max(0, Math.min(100, (s / topScore) * 100));
      }
      (scoreFill as HTMLDivElement).style.width = pct + '%';
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
        (levelFill as HTMLDivElement).style.width = '0%';
        levelText.textContent = '1';
      } else {
        let lvl = 1;
        let remaining = s;
        for (let i = 0; i < levelSteps.length; i++) {
          const need = levelSteps[i] | 0;
          if (remaining >= need) { remaining -= need; lvl++; } else { break; }
        }
        const nextNeed = levelSteps[lvl - 1]; // index is level-1 for L->L+1
        let pct = 100;
        if (typeof nextNeed === 'number' && nextNeed > 0) {
          pct = Math.max(0, Math.min(100, (remaining / nextNeed) * 100));
        } else if (lvl === 1) {
          // Explicitly show empty when at level 1 with no data
          pct = 0;
        }
        (levelFill as HTMLDivElement).style.width = pct + '%';
        levelText.textContent = String(lvl);
      }
    }

	    // Current shark label (update only on change)
	    if (sharkNameEl) {
	      const st = self.sharkType || 'Baby Shark.png';
	      const name = st.replace(/\.png$/i, '');
	      if (name !== lastSharkNameSelf) {
	        sharkNameEl.textContent = name;
	        lastSharkNameSelf = name;
	      }
	    }

  }

  // Update ability UI
  updateAbilityUI();

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

function step(dt: number) {
  if (!selfId) return;
  const me = players[selfId];
  if (!me || (me as any).dead) return;

  // Target velocity from WASD keys
  let vx = 0, vy = 0;
  let mx = 0, my = 0;
  if (keys.w) my -= 1;
  if (keys.s) my += 1;
  if (keys.a) mx -= 1;
  if (keys.d) mx += 1;
  if (mx !== 0 || my !== 0) {
    const invLen = 1 / Math.hypot(mx, my);
    mx *= invLen; my *= invLen;
    // Apply speed boost if active
    const dashState = abilityStates.get('quickDash');
    const speedMultiplier = dashState && Date.now() < dashState.activeUntil ? 3.5 : 1;
    vx = mx * SELF_SPEED * speedMultiplier;
    vy = my * SELF_SPEED * speedMultiplier;
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
    const selfEl = document.getElementById(`p-${selfId}`) as HTMLDivElement | null;
    let cx = window.innerWidth / 2, cy = window.innerHeight / 2;
    if (selfEl) {
      const r = selfEl.getBoundingClientRect();
      cx = r.left + r.width / 2;
      cy = r.top + r.height / 2;
    }
    const dx = mouse.x - cx;
    const dy = mouse.y - cy;
    if (dx !== 0 || dy !== 0) desiredAngle = Math.atan2(dy, dx);
  }
  const diff = Math.atan2(Math.sin(desiredAngle - me.angle), Math.cos(desiredAngle - me.angle));
  me.angle = me.angle + Math.min(1, 10 * dt) * diff;

  // Throttle server emits to ~30fps
  const now = performance.now();
  if (socket && selfId && now - throttleAt > 33) {
    throttleAt = now;
    const p = players[selfId];
    // Use reliable emit to avoid drops during burst traffic (e.g., while shooting)
    socket.emit('player:move', { x: p.x, y: p.y, angle: p.angle });
  }
}

// Add ambient light rays to the world
function addLightRays() {
  if (!world) return;

  // Remove existing light rays
  const existingRays = world.querySelectorAll('.light-ray');
  existingRays.forEach(ray => ray.remove());

  // Add 5-7 light rays at random positions
  const rayCount = 5 + Math.floor(Math.random() * 3);
  for (let i = 0; i < rayCount; i++) {
    const ray = document.createElement('div');
    ray.className = 'light-ray';
    ray.style.left = `${(i / rayCount) * 100 + Math.random() * 10}%`;
    ray.style.animationDelay = `${Math.random() * 5}s`;
    ray.style.animationDuration = `${12 + Math.random() * 6}s`;
    world.appendChild(ray);
  }
}

// Add environmental elements to make the ocean more realistic
function addEnvironmentalElements() {
  if (!world) return;

  // Remove existing environmental elements
  const existingElements = world.querySelectorAll('.seaweed, .coral, .rock, .sand-particle, .bio-light, .floating-log, .lily-pad, .surface-ripple, .bird, .dock, .ocean-floor-bedrock');
  existingElements.forEach(el => el.remove());

  // Add solid ocean floor bedrock to prevent seeing past the ocean floor
  const bedrock = document.createElement('div');
  bedrock.className = 'ocean-floor-bedrock';
  world.appendChild(bedrock);
  // Sand canvas to render realistic sand and the terrain contour
  const sandCanvas = document.createElement('canvas');
  sandCanvas.className = 'ocean-sand-canvas';
  world.appendChild(sandCanvas);

  type GroundObject = { percent: number; approxWidth: number };
  const groundObjects: GroundObject[] = [];

  // Compute ground Y (from top of canvas) for a given x
  const groundYAt = (x: number, width: number, height: number): number => {
    const p = (x / Math.max(1, width)) * 100;
    const h = getTerrainHeight(p);
    return height - h;
  };

  const renderSandCanvas = (canvas: HTMLCanvasElement, objects: GroundObject[]) => {
    // Use MAP_SIZE for canvas width (world coordinates, not transformed screen coordinates)
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const cw = MAP_SIZE; // Use actual world width
    const ch = 450;
    if (canvas.width !== cw * dpr || canvas.height !== ch * dpr) {
      canvas.width = cw * dpr;
      canvas.height = ch * dpr;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cw, ch);

    // Build ground path (contour)
    const path = new Path2D();
    const step = 4; // px step across width
    path.moveTo(0, groundYAt(0, cw, ch));
    for (let x = step; x <= cw; x += step) {
      path.lineTo(x, groundYAt(x, cw, ch));
    }
    path.lineTo(cw, ch);
    path.lineTo(0, ch);
    path.closePath();

    // Sand base fill (vertical gradient)
    const grad = ctx.createLinearGradient(0, 0, 0, ch);
    grad.addColorStop(0.0, 'rgba(0, 110, 140, 0.00)'); // blend to water
    grad.addColorStop(0.35, 'rgba(120, 105, 95, 0.35)');
    grad.addColorStop(0.6, 'rgba(135, 120, 100, 0.55)');
    grad.addColorStop(0.8, 'rgba(150, 130, 110, 0.85)');
    grad.addColorStop(1.0, 'rgba(140, 120, 100, 1.0)');
    ctx.fillStyle = grad;
    ctx.fill(path);

    // Subtle ripples parallel to ground: draw a few offset strokes below contour
    ctx.save();
    ctx.globalAlpha = 0.15;
    ctx.strokeStyle = 'rgba(160,145,125,0.6)';
    for (let o = 12; o <= 90; o += 18) {
      const ripple = new Path2D();
      ripple.moveTo(0, Math.min(ch - 1, groundYAt(0, cw, ch) + o));
      for (let x = step; x <= cw; x += step) {
        const base = groundYAt(x, cw, ch) + o + Math.sin((x + o * 3) * 0.01) * 1.5;
        ripple.lineTo(x, Math.min(ch - 1, base));
      }
      ctx.lineWidth = 1.5;
      ctx.stroke(ripple);
    }
    ctx.restore();

    // Grain: sparse dots for sand texture
    const dots = Math.floor((cw * ch) / 8000);
    for (let i = 0; i < dots; i++) {
      const x = Math.random() * cw;
      const gy = groundYAt(x, cw, ch);
      const y = gy + Math.random() * (ch - gy);
      ctx.fillStyle = Math.random() < 0.6 ? 'rgba(120,105,90,0.25)' : 'rgba(95,80,65,0.2)';
      ctx.fillRect(x, y, 1, 1);
    }

    // Contour line (slightly darker to avoid floating look)
    ctx.save();
    ctx.strokeStyle = 'rgba(90,75,60,0.5)';
    ctx.lineWidth = 2.5;
    const contour = new Path2D();
    contour.moveTo(0, groundYAt(0, cw, ch));
    for (let x = step; x <= cw; x += step) contour.lineTo(x, groundYAt(x, cw, ch));
    ctx.stroke(contour);
    ctx.restore();

    // Contact shadows beneath objects
    ctx.save();
    ctx.globalAlpha = 0.35;
    for (const obj of objects) {
      const x = (obj.percent / 100) * cw;
      const y = groundYAt(x, cw, ch) - 1;
      const w = Math.max(10, obj.approxWidth * 0.6);
      const h = Math.max(6, Math.min(14, obj.approxWidth * 0.18));
      const g = ctx.createRadialGradient(x, y, 0, x, y, w * 0.6);
      g.addColorStop(0, 'rgba(0,0,0,0.35)');
      g.addColorStop(1, 'rgba(0,0,0,0.0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.ellipse(x, y, w / 2, h / 2, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  };

  // Redraw on resize (debounced)
  let sandRaf = 0;
  const queueRedraw = () => {
    if (sandRaf) cancelAnimationFrame(sandRaf);
    sandRaf = requestAnimationFrame(() => renderSandCanvas(sandCanvas, groundObjects));
  };
  window.addEventListener('resize', queueRedraw);


  // === OCEAN FLOOR ELEMENTS (ENHANCED WITH OVERLAP PREVENTION) ===

  // Helper function to check if a position overlaps with existing positions
  const checkOverlap = (newPos: number, existingPositions: number[], minDistance: number): boolean => {
    return existingPositions.some(pos => Math.abs(newPos - pos) < minDistance);
  };

  // Helper function to find a non-overlapping position
  const findNonOverlappingPosition = (existingPositions: number[], minDistance: number, maxAttempts: number = 50): number => {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const newPos = Math.random() * 100;
      if (!checkOverlap(newPos, existingPositions, minDistance)) {
        return newPos;
      }
    }
    // If we can't find a non-overlapping position, return a random one
    return Math.random() * 100;
  };

  // Helper function to calculate terrain height at a given horizontal position
  const getTerrainHeight = (horizontalPercent: number): number => {
    // Simulate the terrain variations from the CSS gradients
    // Hills and elevated areas (higher = closer to surface)
    let height = 0;

    // Hill at 8% position
    if (horizontalPercent >= 5 && horizontalPercent <= 15) {
      const hillCenter = 8;
      const distance = Math.abs(horizontalPercent - hillCenter);
      height += Math.max(0, 40 - (distance * 4)); // Peak of 40px
    }

    // Hill at 25% position
    if (horizontalPercent >= 20 && horizontalPercent <= 35) {
      const hillCenter = 25;
      const distance = Math.abs(horizontalPercent - hillCenter);
      height += Math.max(0, 30 - (distance * 3)); // Peak of 30px
    }

    // Hill at 45% position
    if (horizontalPercent >= 40 && horizontalPercent <= 55) {
      const hillCenter = 45;
      const distance = Math.abs(horizontalPercent - hillCenter);
      height += Math.max(0, 35 - (distance * 3.5)); // Peak of 35px
    }

    // Hill at 68% position
    if (horizontalPercent >= 60 && horizontalPercent <= 75) {
      const hillCenter = 68;
      const distance = Math.abs(horizontalPercent - hillCenter);
      height += Math.max(0, 45 - (distance * 4)); // Peak of 45px
    }

    // Hill at 85% position
    if (horizontalPercent >= 80 && horizontalPercent <= 95) {
      const hillCenter = 85;
      const distance = Math.abs(horizontalPercent - hillCenter);
      height += Math.max(0, 38 - (distance * 3.8)); // Peak of 38px
    }

    // Valleys (negative height = deeper)
    // Valley at 18% position
    if (horizontalPercent >= 15 && horizontalPercent <= 25) {
      const valleyCenter = 18;
      const distance = Math.abs(horizontalPercent - valleyCenter);
      height -= Math.max(0, 20 - (distance * 4)); // Depth of -20px
    }

    // Valley at 58% position
    if (horizontalPercent >= 50 && horizontalPercent <= 65) {
      const valleyCenter = 58;
      const distance = Math.abs(horizontalPercent - valleyCenter);
      height -= Math.max(0, 25 - (distance * 3.5)); // Depth of -25px
    }

    return height;
  };

  // Track positions for overlap prevention
  const seaweedPositions: number[] = [];
  const coralPositions: number[] = [];
  const rockPositions: number[] = [];

  // Add seaweed along the bottom (increased count: 2-3x more)
  const seaweedCount = 20 + Math.floor(Math.random() * 6); // 20-25 seaweed plants
  for (let i = 0; i < seaweedCount; i++) {
    const seaweed = document.createElement('div');
    const types = ['seaweed--tall', 'seaweed--medium', 'seaweed--short'];
    const type = types[Math.floor(Math.random() * types.length)];
    seaweed.className = `seaweed ${type}`;

    // Find position with minimal overlap (3% minimum distance)
    const position = findNonOverlappingPosition(seaweedPositions, 3);
    seaweedPositions.push(position);
    seaweed.style.left = `${position}%`;

    // Position seaweed at terrain height
    const terrainHeight = getTerrainHeight(position);
    seaweed.style.bottom = `${terrainHeight}px`;

    // Track for contact shadow
    const approxWidth = type === 'seaweed--tall' ? 100 : type === 'seaweed--medium' ? 75 : 50;
    groundObjects.push({ percent: position, approxWidth });

    world.appendChild(seaweed);
  }

  // Add coral formations (increased count: 2-3x more)
  const coralCount = 15 + Math.floor(Math.random() * 6); // 15-20 coral pieces
  for (let i = 0; i < coralCount; i++) {
    const coral = document.createElement('div');
    const types = ['coral--brain', 'coral--fan', 'coral--tube'];
    const type = types[Math.floor(Math.random() * types.length)];
    coral.className = `coral ${type}`;

    // Find position with minimal overlap (4% minimum distance for coral)
    const position = findNonOverlappingPosition([...seaweedPositions, ...coralPositions], 4);
    coralPositions.push(position);
    coral.style.left = `${position}%`;

    // Position coral at terrain height
    const terrainHeight = getTerrainHeight(position);
    coral.style.bottom = `${terrainHeight}px`;

    // Track for contact shadow
    const approxWidth = type === 'coral--brain' ? 78 : type === 'coral--fan' ? 65 : 52;
    groundObjects.push({ percent: position, approxWidth });

    world.appendChild(coral);
  }

  // Add rocks scattered on the ocean floor (increased count: 2-3x more)
  const rockCount = 20 + Math.floor(Math.random() * 6); // 20-25 rocks
  for (let i = 0; i < rockCount; i++) {
    const rock = document.createElement('div');
    const types = ['rock--large', 'rock--medium', 'rock--small'];
    const type = types[Math.floor(Math.random() * types.length)];
    rock.className = `rock ${type}`;

    // Find position with minimal overlap (3.5% minimum distance for rocks)
    const position = findNonOverlappingPosition([...seaweedPositions, ...coralPositions, ...rockPositions], 3.5);
    rockPositions.push(position);
    rock.style.left = `${position}%`;

    // Position rock at terrain height
    const terrainHeight = getTerrainHeight(position);
    rock.style.bottom = `${terrainHeight}px`;

    // Track for contact shadow
    const approxWidth = type === 'rock--large' ? 72 : type === 'rock--medium' ? 48 : 32;
    groundObjects.push({ percent: position, approxWidth });

    world.appendChild(rock);
  }

  // Add shells scattered on ocean floor (30-40 shells)
  const shellCount = 30 + Math.floor(Math.random() * 11); // 30-40 shells
  for (let i = 0; i < shellCount; i++) {
    const shell = document.createElement('div');
    const types = ['shell--small', 'shell--medium', 'shell--large'];
    const type = types[Math.floor(Math.random() * types.length)];
    shell.className = `shell ${type}`;

    // Find position with minimal overlap (2% minimum distance for shells)
    const position = findNonOverlappingPosition([...seaweedPositions, ...coralPositions, ...rockPositions], 2);
    shell.style.left = `${position}%`;

    // Position shell at terrain height
    const terrainHeight = getTerrainHeight(position);
    shell.style.bottom = `${terrainHeight}px`;

    // Track for contact shadow
    const approxWidth = type === 'shell--large' ? 40 : type === 'shell--medium' ? 30 : 20;
    groundObjects.push({ percent: position, approxWidth });

    world.appendChild(shell);
  }

  // Add starfish on ocean floor (15-20 starfish)
  const starfishCount = 15 + Math.floor(Math.random() * 6); // 15-20 starfish
  for (let i = 0; i < starfishCount; i++) {
    const starfish = document.createElement('div');
    const types = ['starfish--small', 'starfish--medium'];
    const type = types[Math.floor(Math.random() * types.length)];
    starfish.className = `starfish ${type}`;

    // Find position with minimal overlap (2.5% minimum distance)
    const position = findNonOverlappingPosition([...seaweedPositions, ...coralPositions, ...rockPositions], 2.5);
    starfish.style.left = `${position}%`;

    // Position starfish at terrain height
    const terrainHeight = getTerrainHeight(position);
    starfish.style.bottom = `${terrainHeight}px`;

    // Track for contact shadow
    const approxWidth = type === 'starfish--medium' ? 35 : 25;
    groundObjects.push({ percent: position, approxWidth });

    world.appendChild(starfish);
  }

  // Add sea urchins on ocean floor (10-15 urchins)
  const urchinCount = 10 + Math.floor(Math.random() * 6); // 10-15 urchins
  for (let i = 0; i < urchinCount; i++) {
    const urchin = document.createElement('div');
    const types = ['urchin--small', 'urchin--medium'];
    const type = types[Math.floor(Math.random() * types.length)];
    urchin.className = `urchin ${type}`;

    // Find position with minimal overlap (2.5% minimum distance)
    const position = findNonOverlappingPosition([...seaweedPositions, ...coralPositions, ...rockPositions], 2.5);
    urchin.style.left = `${position}%`;

    // Position urchin at terrain height
    const terrainHeight = getTerrainHeight(position);
    urchin.style.bottom = `${terrainHeight}px`;

    // Track for contact shadow
    const approxWidth = type === 'urchin--medium' ? 26 : 18;
    groundObjects.push({ percent: position, approxWidth });

    world.appendChild(urchin);
  }

  // Add sea anemones on ocean floor (8-12 anemones)
  const anemoneCount = 8 + Math.floor(Math.random() * 5); // 8-12 anemones
  for (let i = 0; i < anemoneCount; i++) {
    const anemone = document.createElement('div');
    const types = ['anemone--small', 'anemone--medium'];
    const type = types[Math.floor(Math.random() * types.length)];
    anemone.className = `anemone ${type}`;

    // Find position with minimal overlap (3% minimum distance)
    const position = findNonOverlappingPosition([...seaweedPositions, ...coralPositions, ...rockPositions], 3);
    anemone.style.left = `${position}%`;

    // Position anemone at terrain height
    const terrainHeight = getTerrainHeight(position);
    anemone.style.bottom = `${terrainHeight}px`;

    // Track for contact shadow
    const approxWidth = type === 'anemone--medium' ? 32 : 22;
    groundObjects.push({ percent: position, approxWidth });

    world.appendChild(anemone);
  }

  // Add pebbles scattered on ocean floor (50-70 pebbles)
  const pebbleCount = 50 + Math.floor(Math.random() * 21); // 50-70 pebbles
  for (let i = 0; i < pebbleCount; i++) {
    const pebble = document.createElement('div');
    const types = ['pebble--tiny', 'pebble--small', 'pebble--medium'];
    const type = types[Math.floor(Math.random() * types.length)];
    pebble.className = `pebble ${type}`;

    // Find position with minimal overlap (1.5% minimum distance for small pebbles)
    const position = findNonOverlappingPosition([...seaweedPositions, ...coralPositions, ...rockPositions], 1.5);
    pebble.style.left = `${position}%`;

    // Position pebble at terrain height
    const terrainHeight = getTerrainHeight(position);
    pebble.style.bottom = `${terrainHeight}px`;

    // Track for contact shadow
    const approxWidth = type === 'pebble--medium' ? 18 : type === 'pebble--small' ? 12 : 8;
    groundObjects.push({ percent: position, approxWidth });

    world.appendChild(pebble);
  }

  // Render sand and contact shadows after placing ground objects
  renderSandCanvas(sandCanvas, groundObjects);

  // === SURFACE ELEMENTS (OPTIMIZED) ===

  // Add floating logs and debris (reduced count)
  const logCount = 3 + Math.floor(Math.random() * 2); // 3-5 floating logs
  for (let i = 0; i < logCount; i++) {
    const log = document.createElement('div');
    const types = ['floating-log--medium', 'floating-log--small'];
    const type = types[Math.floor(Math.random() * types.length)];
    log.className = `floating-log ${type}`;
    log.style.left = `${Math.random() * 100}%`;
    world.appendChild(log);
  }

  // Add lily pads (reduced count)
  const lilyCount = 4 + Math.floor(Math.random() * 3); // 4-7 lily pads
  for (let i = 0; i < lilyCount; i++) {
    const lily = document.createElement('div');
    lily.className = 'lily-pad';
    lily.style.left = `${Math.random() * 100}%`;
    world.appendChild(lily);
  }

  // Add dock structures (reduced count)
  const dockCount = 1 + Math.floor(Math.random() * 1); // 1-2 docks
  for (let i = 0; i < dockCount; i++) {
    const dock = document.createElement('div');
    dock.className = 'dock';
    dock.style.left = `${20 + (i * 50)}%`;
    world.appendChild(dock);
  }
}

// Ambient particle spawning (throttled) - OPTIMIZED: reduced frequency and count
let lastAmbientSpawn = 0;
function spawnAmbientParticles() {
  const now = performance.now();
  if (now - lastAmbientSpawn < 2000) return; // OPTIMIZED: Spawn every 2000ms (was 800ms)
  lastAmbientSpawn = now;

  // OPTIMIZED: Spawn only 1 ambient particle (was 2-3)
  const count = 1;
  for (let i = 0; i < count; i++) {
    const x = Math.random() * window.innerWidth;
    const y = window.innerHeight + 20; // Start below screen
    spawnParticle(x, y, 'ambient');
  }
}

function loop() {
  const now = performance.now();
  const dt = Math.min(0.033, (now - lastFrame) / 1000);
  lastFrame = now;
  const fps = 1 / Math.max(0.0001, dt);
  fpsEMA = fpsEMA ? fpsEMA * 0.9 + fps * 0.1 : fps;
  if (fpsEl) fpsEl.textContent = String(Math.round(fpsEMA));

  step(dt);
  // Pixel-perfect eat checks, throttled to ~15 FPS for better performance (was 20 FPS)
  const t = performance.now();
  if (t - lastEatCheckMs > 66) { lastEatCheckMs = t; checkEatCollisions(); }

  // Spawn ambient particles periodically
  if (!gameEl?.classList.contains('hidden')) {
    spawnAmbientParticles();
  }

  render();
  requestAnimationFrame(loop);
}

function bindGameInteractions(container: HTMLElement) {
  // Track mouse in viewport coordinates for consistent rotation
  const updateMouse = (e: PointerEvent | MouseEvent) => {
    mouse = { x: e.clientX, y: e.clientY };
  };
  window.addEventListener('pointermove', updateMouse);
  window.addEventListener('mousemove', updateMouse);

  // WASD + Arrow Keys movement input
  const onKey = (down: boolean) => (e: KeyboardEvent) => {
    // Only handle keys during gameplay (avoid interfering with input fields/menus)
    if (!gameEl || gameEl.classList.contains('hidden')) return;
    const key = e.key;
    const k = key.toLowerCase();
    let handled = false;
    if (k === 'w' || key === 'ArrowUp') { keys.w = down; handled = true; }
    else if (k === 'a' || key === 'ArrowLeft') { keys.a = down; handled = true; }
    else if (k === 's' || key === 'ArrowDown') { keys.s = down; handled = true; }
    else if (k === 'd' || key === 'ArrowRight') { keys.d = down; handled = true; }
    // Ability activation keys
    else if (k === 'k' && down) {
      activateAbility('quickDash');
      handled = true;
    }
    else if (k === 'l' && down) {
      activateAbility('bubbleShield');
      handled = true;
    }
    // Developer testing: z key for WarriorX12 only
    else if (k === 'z' && down && myUsername === 'WarriorX12') {
      socket?.emit('dev:levelup');
      handled = true;
    }
    if (handled) e.preventDefault();
  };
  window.addEventListener('keydown', onKey(true));
  window.addEventListener('keyup', onKey(false));

  // Shooting: click/press to start hold fire, release to stop
  const down = (cx: number, cy: number) => { if (!gameEl || gameEl.classList.contains('hidden')) return; startHoldFire(); };
  const up = () => { stopHoldFire(); };
  window.addEventListener('mousedown', (e: MouseEvent) => down(e.clientX, e.clientY));
  window.addEventListener('mouseup', up);
  window.addEventListener('pointerdown', (e: PointerEvent) => down(e.clientX, e.clientY));
  window.addEventListener('pointerup', up);
  window.addEventListener('touchstart', () => { startHoldFire(); }, { passive: true });
  window.addEventListener('touchend', () => { stopHoldFire(); }, { passive: true });

  // Defensive: fade lingering projectiles periodically even if server skips an empty update
  setInterval(() => { if (!projectileLayer) return; for (const el of Array.from(projectileLayer.children) as HTMLDivElement[]) { if (!el.classList.contains('out')) { el.classList.add('out'); setTimeout(() => el.remove(), 240); } } }, 3000);

  // Spacebar hold-to-fire
  window.addEventListener('keydown', (e: KeyboardEvent) => {
    const key = e.key;

    // Toggle collision mask visualization with 'M' key (works even in menu)
    if (key === 'm' || key === 'M') {
      showCollisionMasks = !showCollisionMasks;
      console.log(`🎯 Collision mask overlay: ${showCollisionMasks ? 'ON ✓' : 'OFF ✗'}`);
      console.log(`   Masks loaded: ${sharkMasks.size} sharks`);
      console.log(`   Mask size: ${maskSize}x${maskSize}`);
      e.preventDefault();
      return;
    }

    if (!gameEl || gameEl.classList.contains('hidden')) return;
    if (key === ' ' || key === 'Spacebar') { e.preventDefault(); startHoldFire(); }
  });
  window.addEventListener('keyup', (e: KeyboardEvent) => {
    if (!gameEl || gameEl.classList.contains('hidden')) return;
    const key = e.key;
    if (key === ' ' || key === 'Spacebar') { e.preventDefault(); stopHoldFire(); }
  });

  // Prevent zoom shortcuts (FOV hack prevention)
  window.addEventListener('keydown', (e: KeyboardEvent) => {
    // Prevent Cmd/Ctrl + Plus/Minus/0 (zoom shortcuts)
    if ((e.metaKey || e.ctrlKey) && (e.key === '+' || e.key === '-' || e.key === '=' || e.key === '0')) {
      e.preventDefault();
      return false;
    }
  }, { passive: false });

  // Prevent mouse wheel zoom
  window.addEventListener('wheel', (e: WheelEvent) => {
    if (!gameEl || gameEl.classList.contains('hidden')) return;
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      return false;
    }
  }, { passive: false });

  // Prevent pinch zoom on trackpad
  window.addEventListener('gesturestart', (e: Event) => {
    e.preventDefault();
  }, { passive: false });

  window.addEventListener('gesturechange', (e: Event) => {
    e.preventDefault();
  }, { passive: false });

  window.addEventListener('gestureend', (e: Event) => {
    e.preventDefault();
  }, { passive: false });
}

function initSocket(username: string) {
  myUsername = username; // Store for respawn

  // Dynamic socket URL: use localhost in dev, production URL in production
  // Dynamic socket URL: use localhost in dev, production URL in production
  const isDev = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
  const SOCKET_URL = isDev ? 'http://localhost:3002' : window.location.origin;

  console.log('Connecting to socket server:', SOCKET_URL);
  socket = io(SOCKET_URL, {
    path: '/socket.io',
    transports: ['websocket'],
    withCredentials: true
  });

  // Projectiles + death events
  socket.on('projectiles:update', (arr: Array<{ id: number; x: number; y: number }>) => {
    updateProjectiles(arr || []);
  });

  // Immediate projectile removal (when bullet hits something)
  socket.on('projectile:removed', (id: number) => {
    if (!projectileLayer) return;
    const el = document.getElementById(`proj-${id}`);
    if (el) {
      const pos = projectiles[id];
      if (pos) spawnRipple(Math.round(pos.x), Math.round(pos.y), 28);
      el.remove();
      delete projectiles[id];
    }
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
        if (remaining >= need) { remaining -= need; lvl++; } else { break; }
      }
    }
    if (deathTimeEl) deathTimeEl.textContent = `${mins}:${String(secs).padStart(2,'0')}`;
    if (deathScoreEl) deathScoreEl.textContent = String(score);
    if (deathLevelEl) deathLevelEl.textContent = String(lvl);
    deathOverlay?.classList.remove('hidden');
  });
  socket.on('player:respawned', (data: { x: number; y: number; hp: number }) => {
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
        } as Player;
      } else {
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
    selfId = socket!.id || null;
  });

  socket.on('gameState', (data: any) => {
    const payload: { ts?: number; players: Record<string, Player>; foods?: Food[] } =
      data && typeof data === 'object' && 'players' in data
        ? data
        : { players: data } as any;

    // Players
    players = {};
    for (const [id, p] of Object.entries(payload.players)) {
      players[id] = { ...p } as Player;
      ensureSharkEl(id, p.username);
    }

    // Foods
    for (const [fid, el] of Array.from(foodEls.entries())) { removeFoodEl(fid); }
    foods = {};
    if (payload.foods && Array.isArray(payload.foods)) {
      for (const f of payload.foods) {
        foods[f.id] = f;
        ensureFoodEl(f);
      }
    }
  });

  socket.on('player:new', (p: Player) => {
    players[p.id] = { ...p };
    ensureSharkEl(p.id, p.username);
  });

  socket.on('players:update', (data: any) => {
    const payload: { ts?: number; players: Record<string, Player> } =
      data && typeof data === 'object' && 'players' in data
        ? data
        : { players: data };
    for (const [id, sp] of Object.entries(payload.players)) {
      // Debug: log abilities for players with active shields
      if ((sp as any).abilities?.bubbleShield?.activeUntil > Date.now()) {
        console.log(`[CLIENT] Received player ${id} with shield activeUntil=${(sp as any).abilities.bubbleShield.activeUntil}`);
      }

      if (id === selfId) {
        // Keep client prediction for position/angle; still accept authoritative score and HP/death AND abilities
        const me = players[id] || (players[id] = { ...(sp as Player) });
        if ((sp as any).score !== undefined) me.score = (sp as any).score as any;
        if ((sp as any).hp !== undefined) (me as any).hp = (sp as any).hp as any;
        if ((sp as any).dead !== undefined) (me as any).dead = (sp as any).dead as any;
        if ((sp as any).abilities !== undefined) (me as any).abilities = (sp as any).abilities;
        continue;
      }
      const existing = players[id];
      if (!existing) {
        players[id] = { ...(sp as Player) };
        ensureSharkEl(id, sp.username);
      } else {
        existing.x = sp.x; existing.y = sp.y; existing.angle = sp.angle;
        if ((sp as any).score !== undefined) (existing as any).score = (sp as any).score;
        if ((sp as any).hp !== undefined) (existing as any).hp = (sp as any).hp as any;
        if ((sp as any).dead !== undefined) (existing as any).dead = (sp as any).dead as any;
        if ((sp as any).abilities !== undefined) (existing as any).abilities = (sp as any).abilities;
      }
    }
  });

  // Fish food movement updates (server-authoritative)
  socket.on('foods:update', (arr: Array<{ id: number; x: number; y: number }>) => {
    if (!Array.isArray(arr)) return;
    for (const u of arr) {
      // Update local cache
      if (foods[u.id]) { foods[u.id].x = u.x; foods[u.id].y = u.y; } else { foods[u.id] = { id: u.id, x: u.x, y: u.y } as any; }
      // Ensure element exists and update its position
      ensureFoodEl({ id: u.id, x: u.x, y: u.y } as any);
    }
  });

  socket.on('player:left', (id: string) => {
    delete players[id];
    removeSharkEl(id);
  });

  socket.on('food:respawn', (msg: { removedId: number; food: Food }) => {
    if (!msg) return;
    const id = msg.removedId;
    const old = foods[id];
    // Animate old food disappearing
    const oldEl = document.getElementById(`f-${id}`) as HTMLDivElement | null;
    if (oldEl) {
      oldEl.classList.add('food--eaten');
      setTimeout(() => removeFoodEl(id), 130);
    } else {
      removeFoodEl(id);
    }
    // Bite feedback for local player if close to eaten food
    if (selfId && old) {
      const me = players[selfId];
      if (me) {
        const dx = (me.x + SHARK_HALF) - old.x;
        const dy = (me.y + SHARK_HALF) - old.y;
        const maxR = SHARK_HALF + FOOD_RADIUS + 18;
        if ((dx*dx + dy*dy) <= (maxR*maxR)) {
          biteUntil.set(selfId, performance.now() + 160);
          // Eat pop effect
          const pop = document.createElement('div');
          pop.className = 'eat-pop';
          pop.style.left = `${old.x}px`; pop.style.top = `${old.y}px`;
          world.appendChild(pop);
          setTimeout(() => { if (pop.parentElement) pop.parentElement.removeChild(pop); }, 320);
        }
      }
    }

    lastEatEmit.delete(id);
    // Spawn new food
    foods[msg.food.id] = msg.food;
    ensureFoodEl(msg.food);
  });
}

function startGame(username: string) {
  landingEl.classList.add('hidden');
  gameEl.classList.remove('hidden');
  sessionStartMs = performance.now();
  // Remove top padding so the world truly centers to viewport
  gameEl.style.paddingTop = '0px';
  // Hide top bar during gameplay

  (document.querySelector('.site-header') as HTMLElement)?.classList.add('hidden');
  // Bubbles are server-controlled; wait for seeds
  if (bubbleLayer) { bubbleLayer.innerHTML = ''; }

  // Add ambient light rays to the world
  addLightRays();

  // Add environmental elements (seaweed, coral, rocks)
  addEnvironmentalElements();

  initSocket(username);
  // Preload collision maps; the game can start rendering immediately and checks will activate when ready
  loadCollisionMaps().catch(() => {});

  // Server-authoritative overlays

  socket.on('leaderboard:update', (list: Array<{ id: string; username: string; score: number }>) => {
    updateLeaderboard(list);
    // Track current top score for score bar progress
    if (Array.isArray(list) && list.length > 0) {
      topScore = Math.max(0, list[0].score | 0);
    }
  });

  // Level progression table (server-provided)
  socket.on('levels:init', (steps: number[] | { steps: number[] }) => {
    const arr = Array.isArray(steps) ? steps : (steps && Array.isArray((steps as any).steps) ? (steps as any).steps : []);
    levelSteps = (arr as number[]).map((v: any) => Math.max(0, Number(v) | 0));
    levelsReady = levelSteps.length > 0;
  });
  // Tail offsets and scales for all shark types (server-provided)
  socket.on('tails:init', (map: Record<string, { x: number; y: number; s?: number }>) => {
    try {
      if (map && typeof map === 'object') {
        for (const k of Object.keys(map)) {
          const v = map[k];
          if (v && typeof v.x === 'number' && typeof v.y === 'number') {
            sharkTailOffsets.set(k, { x: v.x, y: v.y });
            if (typeof v.s === 'number' && v.s > 0) sharkScales.set(k, v.s);
          }
        }
      }
    } catch {}
  });

  // Collision masks for visualization (debug mode)
  socket.on('masks:init', (data: { masks: Record<string, string>; size: number }) => {
    console.log('📦 Received masks:init event', data ? `${Object.keys(data.masks || {}).length} masks` : 'no data');
    try {
      if (data && data.masks && typeof data.size === 'number') {
        maskSize = data.size;
        let loadedCount = 0;
        for (const [sharkType, base64Mask] of Object.entries(data.masks)) {
          // Decode base64 to Uint8Array
          const binaryString = atob(base64Mask);
          const bytes = new Uint8Array(binaryString.length);
          for (let i = 0; i < binaryString.length; i++) {
            bytes[i] = binaryString.charCodeAt(i);
          }
          sharkMasks.set(sharkType, bytes);
          loadedCount++;
        }
        console.log(`✅ Loaded ${loadedCount} collision masks for visualization (size: ${maskSize}x${maskSize})`);
        console.log(`   Shark types: ${Array.from(sharkMasks.keys()).slice(0, 3).join(', ')}...`);
        console.log('🎮 Press M to toggle collision mask overlay');
      } else {
        console.warn('⚠️ Invalid masks:init data:', data);
      }
    } catch (e) {
      console.error('❌ Failed to load collision masks:', e);
    }
  });

  // Ability activation/deactivation events
  socket.on('ability:activated', (data: { playerId: string; abilityId: 'quickDash' | 'bubbleShield'; activeUntil: number; cooldownUntil: number }) => {
    console.log(`[CLIENT] Received ability:activated:`, data);
    const { playerId, abilityId, activeUntil, cooldownUntil } = data;

    // Update local state if it's our player
    if (playerId === selfId) {
      const state = abilityStates.get(abilityId);
      console.log(`[CLIENT] Updating state for ${abilityId}: activeUntil=${activeUntil}, cooldownUntil=${cooldownUntil}`);
      if (state) {
        state.activeUntil = activeUntil;
        state.cooldownUntil = cooldownUntil;
      }
      console.log(`[CLIENT] Ability ${abilityId} activated (active until ${activeUntil}, cooldown until ${cooldownUntil})`);
    }
  });

  socket.on('ability:deactivated', (data: { playerId: string; abilityId: 'quickDash' | 'bubbleShield'; reason?: string }) => {
    console.log(`[CLIENT] Received ability:deactivated:`, data);
    const { playerId, abilityId, reason } = data;

    // Update local state if it's our player
    if (playerId === selfId) {
      const state = abilityStates.get(abilityId);
      if (state) {
        state.activeUntil = 0;
      }
      console.log(`[CLIENT] Ability ${abilityId} deactivated (reason: ${reason || 'expired'})`);
    }
  });

  socket.on('server:pong', (t0: number) => {
    const rtt = Math.max(0, performance.now() - t0);
    msEMA = msEMA ? (msEMA * 0.7 + rtt * 0.3) : rtt;
    if (msEl) msEl.textContent = String(Math.round(msEMA));
  });
  // Disable ambient background bubbles as per request (non-distracting gameplay)
  socket.on('bubbles:init', (_seeds: Array<{ left: number; delay: number }>) => {
    if (bubbleLayer) {
      bubbleLayer.innerHTML = '';
      (bubbleLayer as HTMLDivElement).style.display = 'none';
    }
  });

  // Kill feed & notifications
  socket.on('feed:kill', (payload: any) => { try { addKillFeedItem(payload); } catch {} });
  socket.on('notify', (msg: { type: string; text: string; ttlMs?: number }) => { if (msg && msg.text) showTopNotice(msg.text, Math.max(1000, Math.min(10000, msg.ttlMs || 5000))); });

  // Evolution event (delay sprite swap slightly so smoke can cover the shark first)
  socket.on('player:evolved', (data: { id: string; username: string; level: number; sharkType: string; x: number; y: number; tailOffset?: { x: number; y: number } }) => {
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

        // Spawn evolution burst at center of screen
        const screenCenterX = window.innerWidth / 2;
        const screenCenterY = window.innerHeight / 2;
        spawnEvolutionBurst(screenCenterX, screenCenterY);
      }

      // Server-side smoke particles are emitted separately; just log
      // console.log(`${data.username} evolved to ${data.sharkType} at level ${data.level}`);
    } catch (e) {
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
  socket.on('effect:smoke', (data: { x: number; y: number; playerId: string; s?: number }) => {
    try {
      const p = players[data.playerId];
      // Use the scale of the CURRENTLY DISPLAYED sprite (handles evolution hold)
      let key = p?.sharkType || 'Baby Shark.png';
      if (p) {
        const hold = evolutionHoldUntil.get(p.id) || 0;
        if (performance.now() < hold) {
          const prev = evolutionPrevSharkType.get(p.id);
          if (prev) key = prev;
        }
      }
      const sLocal = sharkScales.get(key) || 1;
      spawnEvolutionSmoke(data.x, data.y, sLocal);
    } catch (e) {
      console.error('Smoke effect error:', e);
    }
  });

  // Shark-to-shark collision event (authoritative correction for self on collision)
  socket.on('shark:collision', (data: { damage: number; x?: number; y?: number }) => {
    try {
      // Apply subtle camera/UX effects
      if (data.damage > 0) {
        addScreenShake(Math.min(10, data.damage * 0.5));
        pulseVignette();
      }

      // If server sent corrected coordinates, snap self to them (server-authoritative collision resolution)
      if (typeof data.x === 'number' && typeof data.y === 'number' && selfId) {
        const me = players[selfId];
        if (me) {
          me.x = data.x;
          me.y = data.y;
          // Also nudge the DOM element immediately to avoid one-frame mismatch
          const el = document.getElementById(`p-${selfId}`) as HTMLDivElement | null;
          if (el) {
            el.style.transform = `translate3d(${Math.round(me.x)}px, ${Math.round(me.y)}px, 0)`;
          }
        }
      }
    } catch (e) {
      console.error('Collision effect error:', e);
    }
  });

  // Shield pop effect (server-authoritative)
  socket.on('effect:shield-pop', (data: { playerId: string; x: number; y: number; scale: number }) => {
    try {
      // Create a visual "pop" effect at the shield location
      spawnShieldPopEffect(data.x, data.y, data.scale);
    } catch (e) {
      console.error('Shield pop effect error:', e);
    }
  });

  if (pingTimer) clearInterval(pingTimer);
  pingTimer = window.setInterval(() => { try { socket?.emit('client:ping', performance.now()); } catch {} }, 2000);

  // Camera centering is handled each frame in render(); ticker removed for performance
  requestAnimationFrame(loop);
}

function addKillFeedItem(payload: any) {
  if (!payload) return;
  const el = document.getElementById('kill-feed') as HTMLDivElement | null;
  if (!el) return;
  const item = document.createElement('div');
  item.className = 'feed-item';
  const v = payload.victim?.username || 'Unknown';
  const k = payload.killer?.username || 'Unknown';
  const a = payload.assister?.username || '';
  let html = '';
  if (payload.mode === 'assist' && a) {
    html = `<span class="who">${escapeHtml(a)}</span> <span class="assist">assisted</span> <span class="who">${escapeHtml(k)}</span> <span class="what">in killing</span> <span class="who">${escapeHtml(v)}</span>`;
  } else if (payload.mode === 'shared' && a) {
    html = `<span class="who">${escapeHtml(k)}</span> <span class="what">and</span> <span class="who">${escapeHtml(a)}</span> <span class="what">eliminated</span> <span class="who">${escapeHtml(v)}</span>`;
  } else {
    html = `<span class="who">${escapeHtml(k)}</span> <span class="what">killed</span> <span class="who">${escapeHtml(v)}</span>`;
  }
  item.innerHTML = html;
  el.prepend(item);

  // Only remove oldest item when feed overflows (max 4 items)
  // No auto-delete timeout - items stay until pushed out by new kills
  if (el.children.length > 4) {
    const oldest = el.lastElementChild;
    if (oldest) {
      oldest.classList.add('feed-item--removing');
      oldest.animate([
        { opacity: 1, transform: 'translateX(0)' },
        { opacity: 0, transform: 'translateX(-20px)' }
      ], { duration: 200, easing: 'ease-out' }).onfinish = () => {
        oldest.remove();
      };
    }
  }
}

function showTopNotice(text: string, ttlMs = 5000) {
  const el = document.getElementById('top-notify') as HTMLDivElement | null;
  if (!el) return;
  const n = document.createElement('div');
  n.className = 'notice';
  n.textContent = text;
  el.appendChild(n);
  setTimeout(() => { n.style.animation = 'notifyOut .18s ease forwards'; setTimeout(() => n.remove(), 200); }, ttlMs);
}

function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' } as any)[c] || c);
}

function main() {
  world = document.getElementById('world') as HTMLDivElement;
  gameEl = document.getElementById('game') as HTMLDivElement;
  landingEl = document.getElementById('landing')!;
  bubbleLayer = document.getElementById('bubble-layer')!;
  posXEl = document.getElementById('posx')!;
  posYEl = document.getElementById('posy')!;
  minimap = document.getElementById('minimap') as HTMLCanvasElement;
  ctx = minimap.getContext('2d')!;
  // HUD bars
  levelFill = document.getElementById('level-fill')!;
  levelText = document.getElementById('level-text')!;
  scoreFill = document.getElementById('score-fill')!;
  scoreText = document.getElementById('score-text')!;
  sharkNameEl = document.getElementById('shark-name')!;

  // HP bar elements
  hpFillEl = document.getElementById('hp-fill') as HTMLDivElement;
  hpTextEl = document.getElementById('hp-text') as HTMLSpanElement;
  hpStatusEl = document.getElementById('hp-status') as HTMLSpanElement;

  // FX overlays
  fxVignetteEl = document.getElementById('fx-vignette') as HTMLDivElement;
  fxCriticalEl = document.getElementById('fx-critical') as HTMLDivElement;
  fxParticlesEl = document.getElementById('fx-particles') as HTMLDivElement;
  fxChromaticEl = document.getElementById('fx-chromatic') as HTMLDivElement;

  projectileLayer = document.getElementById('projectiles') as HTMLDivElement;
  deathOverlay = document.getElementById('death-overlay') as HTMLDivElement;
  btnRespawn = document.getElementById('btn-respawn') as HTMLButtonElement;
  btnHome = document.getElementById('btn-home') as HTMLButtonElement;
  deathTimeEl = document.getElementById('death-time') as HTMLElement;
  deathScoreEl = document.getElementById('death-score') as HTMLElement;
  deathLevelEl = document.getElementById('death-level') as HTMLElement;

  if (btnRespawn) {
    btnRespawn.onclick = () => {
      console.log('Respawn button clicked, socket:', socket);
      if (socket) {
        socket.emit('player:respawn');
        console.log('Emitted player:respawn');
      } else {
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


  fpsEl = document.getElementById('fps')!;
  msEl = document.getElementById('ms')!;
  lbEl = document.getElementById('leaderboard') as HTMLDivElement;

  // Ensure world element exists and has proper initial transform
  if (world) {
    world.style.transformOrigin = '0 0';
    world.style.willChange = 'transform';
  }

  bindGameInteractions(document.body);

  // Ability icon click handlers
  const speedBoostIcon = document.getElementById('ability-speed-boost');
  const bubbleShieldIcon = document.getElementById('ability-bubble-shield');

  if (speedBoostIcon) {
    speedBoostIcon.addEventListener('click', () => activateAbility('quickDash'));
  }

  if (bubbleShieldIcon) {
    bubbleShieldIcon.addEventListener('click', () => activateAbility('bubbleShield'));
  }

  // Load abilities configuration
  loadAbilitiesConfig();

  // Header / account
  btnLogin = document.getElementById('btn-login') as HTMLButtonElement;
  btnSignup = document.getElementById('btn-signup') as HTMLButtonElement;
  accountChip = document.getElementById('account-chip') as HTMLDivElement;
  accountName = document.getElementById('account-name') as HTMLElement;
  accountMenu = document.getElementById('account-menu') as HTMLDivElement;
  menuLogout = document.getElementById('menu-logout') as HTMLButtonElement;
  menuReset = document.getElementById('menu-reset') as HTMLButtonElement;

  // Modals
  modalSignup = document.getElementById('modal-signup') as HTMLDivElement;
  suUser = document.getElementById('su-username') as HTMLInputElement;
  suPass = document.getElementById('su-password') as HTMLInputElement;
  suErrors = document.getElementById('su-errors') as HTMLElement;
  suCancel = document.getElementById('su-cancel') as HTMLButtonElement;
  suSubmit = document.getElementById('su-submit') as HTMLButtonElement;

  modalLogin = document.getElementById('modal-login') as HTMLDivElement;
  liUser = document.getElementById('li-username') as HTMLInputElement;
  liPass = document.getElementById('li-password') as HTMLInputElement;
  liErrors = document.getElementById('li-errors') as HTMLElement;
  liCancel = document.getElementById('li-cancel') as HTMLButtonElement;
  liSubmit = document.getElementById('li-submit') as HTMLButtonElement;

  modalReset = document.getElementById('modal-reset') as HTMLDivElement;
  rpPass = document.getElementById('rp-password') as HTMLInputElement;
  rpConfirm = document.getElementById('rp-confirm') as HTMLInputElement;
  rpErrors = document.getElementById('rp-errors') as HTMLElement;
  rpCancel = document.getElementById('rp-cancel') as HTMLButtonElement;
  rpSubmit = document.getElementById('rp-submit') as HTMLButtonElement;

  modalProfile = document.getElementById('modal-profile') as HTMLDivElement;
  profileClose = document.getElementById('profile-close') as HTMLButtonElement;
  menuProfile = document.getElementById('menu-profile') as HTMLButtonElement;

  // Password strength indicators
  suStrengthFill = document.getElementById('su-strength-fill') as HTMLElement;
  suStrengthText = document.getElementById('su-strength-text') as HTMLElement;
  rpStrengthFill = document.getElementById('rp-strength-fill') as HTMLElement;
  rpStrengthText = document.getElementById('rp-strength-text') as HTMLElement;

  const input = document.getElementById('username') as HTMLInputElement;
  const play = document.getElementById('play') as HTMLButtonElement;

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
    if (u.length === 0) { suErrors.textContent = 'Username cannot be empty'; return; }
    const p = suPass.value || '';
    const r = await signup(u, p);
    if (!r.ok) { suErrors.textContent = r.error || 'Sign up failed'; return; }
    setSession(r.data!);
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

    setSession(r.data!);
    setUIFromSession();
  });

  // Account dropdown events
  accountChip.addEventListener('click', () => {
    // Guard: only open menu if logged in
    if (!getSession()) return;
    const isOpen = !accountMenu.classList.contains('hidden');
    accountMenu.classList.toggle('hidden');
    accountChip.setAttribute('aria-expanded', String(!isOpen));
  });
  document.addEventListener('click', (e) => {
    if (!accountChip.contains(e.target as Node)) {
      accountMenu.classList.add('hidden');
      accountChip.setAttribute('aria-expanded', 'false');
    }
  });
  accountChip.addEventListener('keydown', (e: KeyboardEvent) => {
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
      const profileGames = document.getElementById('profile-games') as HTMLElement;
      const profileScore = document.getElementById('profile-score') as HTMLElement;
      const profileDate = document.getElementById('profile-date') as HTMLElement;

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
    const input = document.getElementById('username') as HTMLInputElement | null;
    if (input) input.value = '';

    hideLoading();
    setUIFromSession();
  });

  menuReset.addEventListener('click', () => {
    accountMenu.classList.add('hidden');
    accountChip.setAttribute('aria-expanded', 'false');
    rpErrors.textContent='';
    rpPass.value='';
    rpConfirm.value='';
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
    if (!r.ok) { rpErrors.textContent = r.error || 'Failed to update password'; return; }
    closeModal(modalReset);
  });

  play.addEventListener('click', async () => {
    const s = getSession();
    const name = s ? s.username : (input.value || '').trim().slice(0, 20); // Max 20 chars for in-game name
    if (!name) { openModal(modalSignup); return; }

    // Show connecting overlay
    showLoading('Connecting to server...');

    // Small delay for visual feedback
    await new Promise(resolve => setTimeout(resolve, 800));

    // Hide loading and start game
    hideLoading();
    startGame(name);
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') (document.getElementById('play') as HTMLButtonElement).click();
  });

  setUIFromSession();
}

document.addEventListener('DOMContentLoaded', main);

