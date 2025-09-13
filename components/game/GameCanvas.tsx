import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { io } from "socket.io-client";
import type { Socket } from "socket.io-client";
import Image from 'next/image';

interface Player {
    id: string;
    x: number;
    y: number;
    angle: number;
    username: string;
    targetX?: number;
    targetY?: number;
    velocityX?: number;
    velocityY?: number;
}

interface GameState {
    players: { [key: string]: Player };
}

// Map configuration
const MAP_SIZE = 4000; // 4000x4000 pixel map
const MINIMAP_SIZE = 200;

export default function GameCanvas({ username }: { username: string }) {
    const socketRef = useRef<Socket>();
    const [players, setPlayers] = useState<{ [key: string]: Player }>({});
    const playersRef = useRef<{ [key: string]: Player }>({});
    // Map of playerId -> DOM node for per-frame transform updates
    const playerElRefs = useRef<Record<string, HTMLDivElement | null>>({});
    // Buffered server snapshots for remote interpolation
    const remoteBuffersRef = useRef<Record<string, Array<{ x: number; y: number; angle: number; t: number }>>>({});
    // Enhanced per-frame render state with sub-pixel precision
    const renderStateRef = useRef<Record<string, { x: number; y: number; angle: number; vx: number; vy: number }>>({});
    const gameContainerRef = useRef<HTMLDivElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const playerRef = useRef<Player>();
    const animationFrameRef = useRef<number>();
    const updateThrottle = useRef<number>(0);
    const lastTimeRef = useRef<number>(performance.now());
    const mouseRef = useRef<{ x: number; y: number } | null>(null);
    
    // Simplified frame timing
    const frameCountRef = useRef<number>(0);
    const fpsRef = useRef<number>(60);
    const lastFpsCheck = useRef<number>(performance.now());
    
    // Interpolation delay for remote players (ms) to smooth network jitter
    const interpDelayMs = 180;

    
    // Camera state with smooth following
    const [worldOffset, setWorldOffset] = useState({ x: 0, y: 0 });
    const [playerScreenPosition, setPlayerScreenPosition] = useState({ x: 0, y: 0 });
    const [viewportSize, setViewportSize] = useState({ width: 800, height: 600 });
    const cameraTargetRef = useRef({ x: 0, y: 0 });
    const worldRef = useRef<HTMLDivElement>(null);
    const worldTransformRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
    const lastUiUpdateRef = useRef<number>(performance.now());
    const lastWorldCommitRef = useRef<number>(performance.now());
    
    // Get depth-based lighting color
    const getDepthColor = (playerY: number) => {
        const depth = playerY / MAP_SIZE; // 0 at top, 1 at bottom
        
        // Enhanced depth coloring - more realistic ocean depth transition
        const lightness = Math.max(0.05, 1 - depth * 0.95);
        const hue = 210 + depth * 15; // Slightly shift hue with depth
        const saturation = Math.min(100, 40 + depth * 60);
        
        return `hsl(${hue}, ${saturation}%, ${lightness * 35}%)`;
    };

    // Update viewport size
    useEffect(() => {
        const updateViewportSize = () => {
            if (gameContainerRef.current) {
                setViewportSize({
                    width: gameContainerRef.current.clientWidth,
                    height: gameContainerRef.current.clientHeight
                });
            }
        };

        updateViewportSize();
        window.addEventListener('resize', updateViewportSize);
        return () => window.removeEventListener('resize', updateViewportSize);
    }, []);

    // Update camera target to keep player centered
    useEffect(() => {
        if (socketRef.current?.id && players[socketRef.current.id]) {
            const currentPlayer = players[socketRef.current.id];
            cameraTargetRef.current = {
                x: viewportSize.width / 2 - currentPlayer.x - 50,
                y: viewportSize.height / 2 - currentPlayer.y - 50
            };
        }
    }, [players, viewportSize]);

    // Simplified camera loop for better performance
    useEffect(() => {
        let raf: number;
        let cx = worldOffset.x;
        let cy = worldOffset.y;
        
        const tick = () => {
            const tx = cameraTargetRef.current.x;
            const ty = cameraTargetRef.current.y;
            
            // Simple linear interpolation
            const lerp = 0.15;
            cx = cx + (tx - cx) * lerp;
            cy = cy + (ty - cy) * lerp;
            
            if (worldRef.current) {
                worldRef.current.style.transform = `translate3d(${Math.round(cx)}px, ${Math.round(cy)}px, 0)`;
            }
            worldTransformRef.current = { x: cx, y: cy };
            
            // Less frequent React updates
            const now = performance.now();
            if (now - lastWorldCommitRef.current > 100) { // 10fps React updates
                lastWorldCommitRef.current = now;
                setWorldOffset({ x: cx, y: cy });
            }
            
            raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(raf);
    }, []);
    
    // Update player screen position
    useEffect(() => {
        if (socketRef.current?.id && players[socketRef.current.id]) {
            const currentPlayer = players[socketRef.current.id];
            setPlayerScreenPosition({
                x: currentPlayer.x + worldOffset.x + 50,
                y: currentPlayer.y + worldOffset.y + 50
            });
        }
    }, [players, worldOffset]);

    // Memoize background specks/bubbles layout (static per mount)
    const bubbles = useMemo(() => {
        const arr: { key: string; left: string; top: number; size: number; opacity: number; delay: string; duration: string }[] = [];
        for (let i = 0; i < 20; i++) {
            const depth = i / 20;
            const y = depth * MAP_SIZE;
            const bubbleCount = Math.max(1, 10 - depth * 8);
            const bubbleOpacity = Math.max(0.1, 0.6 - depth * 0.4);
            for (let j = 0; j < Math.floor(bubbleCount); j++) {
                arr.push({
                    key: `bubble-${i}-${j}`,
                    left: `${(j * 13 + i * 7) % 100}%`,
                    top: y + Math.random() * 200,
                    size: Math.random() * 3 + 1,
                    opacity: bubbleOpacity,
                    delay: `${Math.random() * 3}s`,
                    duration: `${4 + Math.random() * 2}s`
                });
            }
        }
        return arr;
    }, []);

    const specks = useMemo(() => {
        return Array.from({ length: 50 }).map((_, i) => ({
            key: `speck-${i}`,
            cls: i % 2 ? 'parallax-slow' : 'parallax-very-slow',
            left: `${(i * 23) % 100}%`,
            top: Math.random() * MAP_SIZE,
            opacity: Math.random() * 0.25 + 0.05,
            delay: `${Math.random() * 6}s`
        }));
    }, []);
    // Ultra-smooth movement animation loop with enhanced frame timing
    const animate = useCallback(() => {
        const now = performance.now();
        const rawDt = now - lastTimeRef.current;
        
        // Simple frame timing
        const dt = Math.min(0.033, rawDt / 1000); // Cap at 33ms
        
        // FPS calculation every second
        frameCountRef.current++;
        if (now - lastFpsCheck.current > 1000) {
            fpsRef.current = Math.round(frameCountRef.current * 1000 / (now - lastFpsCheck.current));
            frameCountRef.current = 0;
            lastFpsCheck.current = now;
        }
        
        lastTimeRef.current = now;

        const updatedPlayers = { ...playersRef.current };
        let hasUpdates = false;

        const selfId = socketRef.current?.id;

        Object.keys(updatedPlayers).forEach(playerId => {
            const player = updatedPlayers[playerId];
                if (!player) return;

                const isSelf = playerId === selfId;

                if (isSelf) {
                    // Calculate direction from screen center to mouse
                    const mouse = mouseRef.current;
                    let desiredVelX = 0;
                    let desiredVelY = 0;
                    let desiredAngle = player.angle || 0;

                    if (mouse && gameContainerRef.current) {
                        // Compute vector from the shark's current on-screen position to the mouse
                        const wx = worldTransformRef.current.x;
                        const wy = worldTransformRef.current.y;
                        const sharkScreenX = player.x + wx + 50; // center of sprite
                        const sharkScreenY = player.y + wy + 50;
                        const dxScreen = mouse.x - sharkScreenX;
                        const dyScreen = mouse.y - sharkScreenY;

                        const len = Math.hypot(dxScreen, dyScreen);

                        // Always rotate to face the cursor, even in dead zone
                        desiredAngle = Math.atan2(dyScreen, dxScreen);

                        // Dead zone near center to allow stopping translation
                        const deadZone = 6;
                        if (len > deadZone) {
                            const dirX = dxScreen / (len || 1);
                            const dirY = dyScreen / (len || 1);

                            // Pixels per second (2x slower)
                            const MAX_SPEED = 210; // was 420
                            desiredVelX = dirX * MAX_SPEED;
                            desiredVelY = dirY * MAX_SPEED;
                        } else {
                            desiredVelX = 0;
                            desiredVelY = 0;
                        }
                    }

                    // Current velocity
                    const currentVelX = player.velocityX || 0;
                    const currentVelY = player.velocityY || 0;

                    // Simplified acceleration for better performance
                    const ACCEL = 8; // Faster response
                    const lerpFactor = ACCEL * dt;
                    const newVelX = currentVelX + (desiredVelX - currentVelX) * lerpFactor;
                    const newVelY = currentVelY + (desiredVelY - currentVelY) * lerpFactor;

                    // Integrate position
                    let newX = player.x + newVelX * dt;
                    let newY = player.y + newVelY * dt;

                    // Clamp to map
                    newX = Math.max(0, Math.min(MAP_SIZE - 100, newX));
                    newY = Math.max(0, Math.min(MAP_SIZE - 100, newY));

                    // Simplified rotation
                    const currentAngle = player.angle || 0;
                    const angleDiff = desiredAngle - currentAngle;
                    const normalizedAngleDiff = Math.atan2(Math.sin(angleDiff), Math.cos(angleDiff));
                    
                    // Direct rotation with simple lerp
                    const rotLerpFactor = 10 * dt;
                    const newAngle = currentAngle + normalizedAngleDiff * Math.min(rotLerpFactor, 1);

                    updatedPlayers[playerId] = {
                        ...player,
                        x: newX,
                        y: newY,
                        velocityX: newVelX,
                        velocityY: newVelY,
                        angle: newAngle
                    };
                    hasUpdates = true;
                } else {
                    // Remote players: keep smoothing towards their last server-reported targetX/targetY
                    if (player.targetX === undefined || player.targetY === undefined) return;

                    const dx = player.targetX - player.x;
                    const dy = player.targetY - player.y;
                    const distance = Math.hypot(dx, dy);

                    const MAX_SPEED = 210;
                    const ACCEL = 6;
                    const lerp = ACCEL * dt;

                    if (distance > 0.5) {
                        const dirX = dx / (distance || 1);
                        const dirY = dy / (distance || 1);
                        const desiredVelX = dirX * MAX_SPEED;
                        const desiredVelY = dirY * MAX_SPEED;

                        const currentVelX = player.velocityX || 0;
                        const currentVelY = player.velocityY || 0;

                        const newVelX = currentVelX + (desiredVelX - currentVelX) * lerp;
                        const newVelY = currentVelY + (desiredVelY - currentVelY) * lerp;

                        const newX = Math.max(0, Math.min(MAP_SIZE - 100, player.x + newVelX * dt));
                        const newY = Math.max(0, Math.min(MAP_SIZE - 100, player.y + newVelY * dt));

                        updatedPlayers[playerId] = {
                            ...player,
                            x: newX,
                            y: newY,
                            velocityX: newVelX,
                            velocityY: newVelY
                        };
                        hasUpdates = true;
                    } else {
                        // Simple deceleration when very close
                        const dampingFactor = Math.max(0, 1 - 5 * dt);
                        updatedPlayers[playerId] = {
                            ...player,
                            velocityX: (player.velocityX || 0) * dampingFactor,
                            velocityY: (player.velocityY || 0) * dampingFactor
                        };
                    }

                    // Angle smoothing towards reported angle if present
                    if (player.targetX !== undefined && player.targetY !== undefined) {
                        const targetDx = player.targetX - (player.x + 50);
                        const targetDy = player.targetY - (player.y + 50);
                        const targetAngle = Math.atan2(targetDy, targetDx);
                        const currentAngle = updatedPlayers[playerId].angle || 0;
                        const aDiff = targetAngle - currentAngle;
                        const norm = Math.atan2(Math.sin(aDiff), Math.cos(aDiff));
                        // Remote turn with bounded speed as well
                        const ROT_MAX_SPEED = 12; // rad/s for remotes
                        const maxStep = ROT_MAX_SPEED * dt;
                        const clamped = Math.max(-maxStep, Math.min(maxStep, norm));
                        updatedPlayers[playerId].angle = currentAngle + clamped;
                    }
                }
        });

        if (hasUpdates) {
            playersRef.current = updatedPlayers;
            // Keep the current player's ref in sync immediately to avoid stale emits
            if (selfId && updatedPlayers[selfId]) {
                playerRef.current = updatedPlayers[selfId];
            }
            const nowTs = performance.now();
            // Further reduce React update frequency for better performance
            if (nowTs - lastUiUpdateRef.current > 100) { // ~10fps for React state
                lastUiUpdateRef.current = nowTs;
                setPlayers({ ...updatedPlayers });
            }
        }

        // Throttle server updates for self
        const nowMs = performance.now();
        if (socketRef.current?.id && playerRef.current) {
            const timeSince = nowMs - updateThrottle.current;
            if (timeSince > 50) { // 20fps server updates
                updateThrottle.current = nowMs;
        const p = playersRef.current[socketRef.current.id] || playerRef.current;
                if (p && socketRef.current) {
                    // Volatile emit: okay to drop frames under load, reduces server/network pressure
                    (socketRef.current as any).volatile.emit('player:move', {
                        x: p.x,
                        y: p.y,
                        angle: p.angle
                    });
                }
            }
        }

        // Per-frame visual interpolation and DOM transform application
        // Compute a display state for each player. Self uses predicted position; remotes use buffered interpolation.
        const displayTime = performance.now() - interpDelayMs;
        const renderStates: Record<string, { x: number; y: number; angle: number; vx: number; vy: number }> = {};
        Object.keys(playersRef.current).forEach(id => {
            const p = playersRef.current[id];
            if (!p) return;
            let rx = p.x;
            let ry = p.y;
            let ra = p.angle || 0;

            if (socketRef.current?.id !== id) {
                const buf = remoteBuffersRef.current[id];
                if (buf && buf.length >= 1) {
                    // Helper: Catmull-Rom interpolation (uniform)
                    const catmull = (p0: number, p1: number, p2: number, p3: number, t: number) => {
                        const t2 = t * t;
                        const t3 = t2 * t;
                        return 0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
                    };

                    const n = buf.length;
                    if (displayTime <= buf[0].t) {
                        // Before buffer start, clamp to first sample
                        rx = buf[0].x; ry = buf[0].y; ra = buf[0].angle;
                    } else if (displayTime >= buf[n - 1].t) {
                        // After last sample: extrapolate with damping up to 250ms
                        const last = buf[n - 1];
                        const prev = buf[n - 2] || last;
                        const dt = Math.max(1, last.t - prev.t);
                        const vx = (last.x - prev.x) / dt; // px/ms
                        const vy = (last.y - prev.y) / dt;
                        const angDiff = Math.atan2(Math.sin(last.angle - prev.angle), Math.cos(last.angle - prev.angle));
                        const w = angDiff / dt; // rad/ms
                        const dtEx = Math.min(250, displayTime - last.t);
                        const damping = 0.85; // reduces overshoot
                        rx = last.x + vx * dtEx * damping;
                        ry = last.y + vy * dtEx * damping;
                        ra = last.angle + w * dtEx * damping;
                    } else {
                        // Find segment [i, i+1]
                        let i = 0;
                        for (; i < n - 1; i++) {
                            if (buf[i].t <= displayTime && displayTime <= buf[i + 1].t) break;
                        }
                        const s0 = buf[Math.max(0, i - 1)];
                        const s1 = buf[i];
                        const s2 = buf[i + 1];
                        const s3 = buf[Math.min(n - 1, i + 2)];
                        const span = Math.max(1, s2.t - s1.t);
                        const tt = Math.min(1, Math.max(0, (displayTime - s1.t) / span));
                        // Cubic for position for extreme smoothness
                        rx = catmull(s0.x, s1.x, s2.x, s3.x, tt);
                        ry = catmull(s0.y, s1.y, s2.y, s3.y, tt);
                        // Shortest-arc linear interpolation for angle
                        const aDiff = Math.atan2(Math.sin(s2.angle - s1.angle), Math.cos(s2.angle - s1.angle));
                        ra = s1.angle + aDiff * tt;
                    }
                }
            }
            // Simplified visual smoothing for better performance
            const prev = renderStateRef.current[id];
            let vx = 0, vy = 0;
            
            if (prev) {
                // Simple visual smoothing
                const VIS_LERP = 0.8;
                rx = prev.x + (rx - prev.x) * VIS_LERP;
                ry = prev.y + (ry - prev.y) * VIS_LERP;
                
                // Simple angle interpolation
                const ad = Math.atan2(Math.sin(ra - prev.angle), Math.cos(ra - prev.angle));
                ra = prev.angle + ad * VIS_LERP;
            }
            
            renderStates[id] = { x: rx, y: ry, angle: ra, vx, vy };
        });
        renderStateRef.current = renderStates;

        // Apply transforms with reduced precision for better performance
        for (const [id, state] of Object.entries(renderStates)) {
            const el = playerElRefs.current[id];
            if (el) {
                // Reduced precision for better performance
                const x = Math.round(state.x * 10) / 10; // 1 decimal place
                const y = Math.round(state.y * 10) / 10;
                const angle = Math.round((state.angle + Math.PI) * 100) / 100; // 2 decimal places
                
                el.style.transform = `translate3d(${x}px, ${y}px, 0) rotate(${angle}rad)`;
            }
        }

        // Schedule next frame with high priority
        animationFrameRef.current = requestAnimationFrame(animate);
    }, []);

    useEffect(() => {
        // Initialize animation loop with immediate start
        animationFrameRef.current = requestAnimationFrame(animate);
        
        return () => {
            if (animationFrameRef.current) {
                cancelAnimationFrame(animationFrameRef.current);
                animationFrameRef.current = undefined;
            }
        };
    }, [animate]);

    useEffect(() => {
        // Connect to game server
        socketRef.current = io('http://localhost:3002');
        const socket = socketRef.current;

        // Join the game
        socket.emit('player:join', username);

        // Handle initial game state (compatible with payloads that may include a server timestamp)
        socket.on('gameState', (data: any) => {
            const payload: { ts?: number; players: GameState['players'] } =
                data && typeof data === 'object' && 'players' in data
                    ? (data as { ts?: number; players: GameState['players'] })
                    : { players: (data as GameState).players ?? (data as any), ts: undefined };

            const processedPlayers: { [key: string]: Player } = {};
            const nowPerf = performance.now();
            const perfOffset = nowPerf - Date.now();
            const baseT = payload.ts ? payload.ts + perfOffset : nowPerf;

            Object.entries(payload.players).forEach(([id, player]) => {
                processedPlayers[id] = {
                    ...player,
                    targetX: player.x,
                    targetY: player.y,
                    velocityX: 0,
                    velocityY: 0
                };
                // Seed render state and buffers
                renderStateRef.current[id] = { x: player.x, y: player.y, angle: player.angle, vx: 0, vy: 0 };
                if (socket.id !== id) {
                    remoteBuffersRef.current[id] = [{ x: player.x, y: player.y, angle: player.angle, t: baseT }];
                }
            });
            playersRef.current = processedPlayers;
            setPlayers(processedPlayers);
        });

        // Handle new player joining
        socket.on('player:new', (player: Player) => {
            const merged = {
                ...playersRef.current,
                [player.id]: {
                    ...player,
                    targetX: player.x,
                    targetY: player.y,
                    velocityX: 0,
                    velocityY: 0
                }
            };
            playersRef.current = merged;
            setPlayers(merged);
            // Initialize refs/buffers for new remote players
            renderStateRef.current[player.id] = { x: player.x, y: player.y, angle: player.angle, vx: 0, vy: 0 };
            if (socket.id !== player.id) {
                remoteBuffersRef.current[player.id] = [{ x: player.x, y: player.y, angle: player.angle, t: performance.now() }];
            }
        });

        // Handle player movements (legacy per-player event)
        socket.on('player:moved', ({ id, x, y, angle }: Player) => {
            // Ignore updates for self to preserve client-side prediction
            if (id === socket.id) return;
            const p = playersRef.current[id];
            if (!p) return;
            playersRef.current[id] = { ...p, targetX: x, targetY: y, angle };
            // Push into interpolation buffer
            const now = performance.now();
            const buf = remoteBuffersRef.current[id] || [];
            buf.push({ x, y, angle, t: now });
            // Keep only recent window
            const cutoff = now - 1500;
            remoteBuffersRef.current[id] = buf.filter(s => s.t >= cutoff);
        });

        // Batched server updates to reduce network load and lag
    socket.on('players:update', (data: any) => {
            // Support both legacy payload (object map) and new payload ({ ts, players })
            const payload: { ts?: number; players: { [key: string]: Player } } =
                data && typeof data === 'object' && 'players' in data
                    ? (data as { ts?: number; players: { [key: string]: Player } })
                    : { players: (data as { [key: string]: Player }), ts: undefined };

            const updated: { [key: string]: Player } = { ...playersRef.current };

            // Convert server epoch ts to the performance timeline if provided
            const perfNow = performance.now();
            const perfOffset = perfNow - Date.now();
            const packetT = payload.ts ? payload.ts + perfOffset : perfNow;

            Object.entries(payload.players).forEach(([id, sp]) => {
                // Ignore our own server echo; use local prediction
                if (id === socket.id) return;
                const existing = updated[id];
                if (existing) {
                    updated[id] = {
                        ...existing,
                        targetX: sp.x,
                        targetY: sp.y,
                        angle: sp.angle
                    };
                } else {
                    updated[id] = {
                        ...sp,
                        targetX: sp.x,
                        targetY: sp.y,
                        velocityX: 0,
                        velocityY: 0
                    } as Player;
                }
                // Buffer snapshots for remote interpolation with server-aligned timestamp
                const buf = remoteBuffersRef.current[id] || [];
                buf.push({ x: sp.x, y: sp.y, angle: sp.angle, t: packetT });
                const cutoff = packetT - 1500; // keep 1.5s history
                remoteBuffersRef.current[id] = buf.filter(s => s.t >= cutoff);
            });
            playersRef.current = updated;
            const nowTs = performance.now();
            if (nowTs - lastUiUpdateRef.current > 100) { // 10fps React updates
                lastUiUpdateRef.current = nowTs;
                setPlayers({ ...updated });
            }
        });

        // Handle player leaving
        socket.on('player:left', (playerId: string) => {
            const newPlayers = { ...playersRef.current };
            delete newPlayers[playerId];
            playersRef.current = newPlayers;
            setPlayers(newPlayers);
            // Cleanup refs and buffers
            delete playerElRefs.current[playerId];
            delete remoteBuffersRef.current[playerId];
            delete renderStateRef.current[playerId];
        });

        return () => {
            socket.disconnect();
        };
    }, [username]);

    // Handle mouse tracking (no direct movement updates here)
    useEffect(() => {
        const handleMouseMove = (e: MouseEvent) => {
            if (!gameContainerRef.current) return;
            const rect = gameContainerRef.current.getBoundingClientRect();
            mouseRef.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
        };
        const handleMouseLeave = () => {
            // Optional: keep last position; comment out to stop on leave
            // mouseRef.current = null;
        };
        const container = gameContainerRef.current;
        if (container) {
            container.addEventListener('mousemove', handleMouseMove);
            container.addEventListener('mouseleave', handleMouseLeave);
        }
        return () => {
            if (container) {
                container.removeEventListener('mousemove', handleMouseMove);
                container.removeEventListener('mouseleave', handleMouseLeave);
            }
        };
    }, []);

    // Store the current player's reference
    useEffect(() => {
        if (socketRef.current?.id && players[socketRef.current.id]) {
            playerRef.current = players[socketRef.current.id];
        }
    }, [players]);

    return (
        <div 
            ref={gameContainerRef}
            className="relative w-full h-screen overflow-hidden no-zoom"
            style={{
                backgroundColor: getDepthColor(socketRef.current?.id && players[socketRef.current.id] ? players[socketRef.current.id].y : 0),
                cursor: 'crosshair',
                touchAction: 'none',
                userSelect: 'none'
            }}
        >
            {/* Main game world - GPU translated for smooth camera */}
            <div 
                ref={worldRef}
                className="absolute will-change-transform"
                style={{
                    width: MAP_SIZE,
                    height: MAP_SIZE,
                    transform: `translate3d(${worldOffset.x}px, ${worldOffset.y}px, 0)`,
                    background: `linear-gradient(180deg, 
                        hsl(210, 40%, 45%) 0%, 
                        hsl(210, 50%, 30%) 15%,
                        hsl(210, 60%, 20%) 35%,
                        hsl(210, 70%, 12%) 60%,
                        hsl(210, 80%, 6%) 85%,
                        hsl(210, 90%, 2%) 100%)`
                }}
            >
                {/* Professional underwater layers */}
                <div className="absolute inset-0 pointer-events-none">
                    {/* Sun rays near surface */}
                    <div
                        className="absolute inset-0 underwater-rays"
                        style={{
                            opacity: socketRef.current?.id && players[socketRef.current.id]
                                ? Math.max(0, 0.25 - (players[socketRef.current.id].y / MAP_SIZE) * 0.25)
                                : 0.2
                        }}
                    />

                    {/* Subtle caustics overlay that shifts over time */}
                    <div
                        className="absolute inset-0 caustics-overlay"
                        style={{
                            opacity: socketRef.current?.id && players[socketRef.current.id]
                                ? Math.max(0.05, 0.2 - (players[socketRef.current.id].y / MAP_SIZE) * 0.18)
                                : 0.16
                        }}
                    />
                    {/* Depth zones with different bubble densities */}
                    {bubbles.map(b => (
                        <div
                            key={b.key}
                            className="animate-bubble absolute bg-white rounded-full"
                            style={{
                                left: b.left,
                                top: b.top,
                                width: b.size,
                                height: b.size,
                                opacity: b.opacity,
                                animationDelay: b.delay,
                                animationDuration: b.duration
                            }}
                        />
                    ))}
                    
                    {/* Subtle specks with parallax to add depth */}
                    {specks.map(s => (
                        <div
                            key={s.key}
                            className={`speck ${s.cls}`}
                            style={{
                                left: s.left,
                                top: s.top,
                                opacity: s.opacity,
                                animationDelay: s.delay
                            }}
                        />
                    ))}
                    
                    {/* Legacy shimmer kept subtle for texture */}
                    <div
                        className="absolute inset-0"
                        style={{
                            opacity: 0.05,
                            animation: 'shimmer 10s ease-in-out infinite'
                        }}
                    />
                </div>

                {/* Small fish schools in the background */}
                <div className="absolute inset-0 pointer-events-none" aria-hidden="true">
                    {[0,1].map((k) => (
                        <div
                            key={`school-${k}`}
                            className="fish-school"
                            style={{
                                top: `${20 + k * 25}%`,
                                left: `${-10 - k * 5}%`,
                                animationDuration: `${28 + k * 6}s`,
                                animationDelay: `${k * 3}s`
                            }}
                        >
                            {[...Array(12)].map((_, i) => (
                                <div
                                    key={`fish-${k}-${i}`}
                                    className="fish-body"
                                    style={{
                                        left: i * 24 + (k % 2 ? (i % 3) * 2 : 0),
                                        top: (Math.sin(i) * 6) + (i % 4),
                                        opacity: 0.6 - (i * 0.03)
                                    }}
                                />
                            ))}
                        </div>
                    ))}
                </div>

                {/* Map boundaries visualization */}
                <div className="absolute inset-0 border-2 border-blue-300/20 pointer-events-none" />
                
                {/* Depth indicators */}
                {[...Array(10)].map((_, i) => {
                    const depth = (i + 1) * (MAP_SIZE / 10);
                    return (
                        <div
                            key={`depth-${i}`}
                            className="absolute left-4 text-white/50 text-sm font-mono"
                            style={{ top: depth - 10 }}
                        >
                            {Math.round(depth / MAP_SIZE * 100)}% Depth
                        </div>
                    );
                })}

                {/* Render all players with offscreen culling */}
                {Object.values(players).map((player) => {
                    const isCurrentPlayer = socketRef.current?.id === player.id;
                    const depthFactor = player.y / MAP_SIZE;
                    const brightness = Math.max(0.2, 1 - depthFactor * 0.8);
                    // Offscreen culling with margin
                    const margin = 200;
                    const px = player.x + worldOffset.x;
                    const py = player.y + worldOffset.y;
                    const inView =
                        px > -margin &&
                        py > -margin &&
                        px < viewportSize.width + margin &&
                        py < viewportSize.height + margin;
                    if (!inView) return null;
                    
                    return (
                        <div
                            key={player.id}
                            className="absolute"
                            ref={(el) => {
                                if (!el) {
                                    delete playerElRefs.current[player.id];
                                    return;
                                }
                                playerElRefs.current[player.id] = el;
                                // Set an initial high-precision transform to avoid visual pop
                                const rs = renderStateRef.current[player.id];
                                const x0 = (rs?.x ?? player.x).toFixed(3);
                                const y0 = (rs?.y ?? player.y).toFixed(3);
                                const a0 = ((rs?.angle ?? player.angle) + Math.PI).toFixed(6);
                                
                                // Optimize for smooth transforms
                                el.style.transformOrigin = '50px 50px';
                                el.style.willChange = 'transform';
                                el.style.backfaceVisibility = 'hidden'; // Hardware acceleration
                                el.style.perspective = '1000px'; // 3D rendering context
                                el.style.transform = `translate3d(${x0}px, ${y0}px, 0) rotate(${a0}rad)`;
                            }}
                            style={{
                                // transform applied per-frame in animation loop for ultra-smooth interpolation
                                // Since the shark's head points to the left in the image, add π (180°) to make it point right when angle=0
                                transformOrigin: '50px 50px',
                                willChange: 'transform',
                                filter: `brightness(${brightness}) contrast(${1 + depthFactor * 0.2}) saturate(${Math.max(0.5, 1 - depthFactor * 0.5)})`,
                                zIndex: isCurrentPlayer ? 10 : 5,
                                // Remove transition for immediate response
                                transition: 'none'
                            }}
                        >
                            {/* Shark image with enhanced styling */}
                            <div className="relative">
                                <Image
                                    src="/sharks/babyshark.png"
                                    alt="Shark"
                                    width={100}
                                    height={100}
                                    className={`block ${isCurrentPlayer ? 'drop-shadow-lg' : ''}`}
                                    priority={isCurrentPlayer}
                                    style={{
                                        imageRendering: 'crisp-edges'
                                    }}
                                />
                                

                                

                            </div>
                            
                            {/* Player name with enhanced styling */}
                            <div 
                                className={`absolute -top-10 left-1/2 transform -translate-x-1/2 text-xs whitespace-nowrap px-3 py-1 rounded-full backdrop-blur-sm border ${
                                    isCurrentPlayer 
                                        ? 'text-yellow-200 bg-yellow-900/60 border-yellow-400/40' 
                                        : 'text-white bg-black/60 border-white/30'
                                }`}
                                style={{
                                    textShadow: '0 1px 2px rgba(0, 0, 0, 0.8)',
                                    fontSize: '11px',
                                    fontWeight: '600'
                                }}
                            >
                                {player.username}
                                {isCurrentPlayer && (
                                    <span className="ml-1 text-yellow-300">●</span>
                                )}
                            </div>
                        </div>
                    );
                })}
            </div>

            {/* Professional Enhanced Minimap */}
            <div 
                className="absolute top-4 right-4 border-2 border-white/40 rounded-xl overflow-hidden backdrop-blur-md shadow-2xl"
                style={{
                    width: MINIMAP_SIZE,
                    height: MINIMAP_SIZE,
                    backgroundColor: 'rgba(0, 30, 60, 0.85)',
                    boxShadow: '0 8px 32px rgba(0, 0, 0, 0.4), inset 0 1px 0 rgba(255, 255, 255, 0.1)'
                }}
            >
                {/* Minimap header */}
                <div className="absolute -top-7 left-0 text-white/90 text-xs font-bold tracking-wide">
                    SONAR MAP
                </div>
                
                <div className="relative w-full h-full">
                    {/* Minimap background gradient with depth zones */}
                    <div 
                        className="absolute inset-0"
                        style={{
                            background: `linear-gradient(180deg, 
                                rgba(100, 180, 255, 0.6) 0%, 
                                rgba(60, 140, 220, 0.5) 15%,
                                rgba(30, 100, 180, 0.4) 35%,
                                rgba(15, 60, 140, 0.3) 60%,
                                rgba(5, 20, 80, 0.2) 85%,
                                rgba(0, 0, 20, 0.4) 100%)`
                        }}
                    />
                    
                    {/* Professional grid system */}
                    <div className="absolute inset-0">
                        {/* Major grid lines */}
                        {[...Array(4)].map((_, i) => (
                            <div key={`major-grid-${i}`}>
                                <div 
                                    className="absolute w-full border-t border-cyan-300/30"
                                    style={{ top: `${(i + 1) * 20}%` }}
                                />
                                <div 
                                    className="absolute h-full border-l border-cyan-300/30"
                                    style={{ left: `${(i + 1) * 20}%` }}
                                />
                            </div>
                        ))}
                        {/* Minor grid lines */}
                        {[...Array(8)].map((_, i) => (
                            <div key={`minor-grid-${i}`}>
                                <div 
                                    className="absolute w-full border-t border-cyan-400/15"
                                    style={{ top: `${(i + 1) * 10}%` }}
                                />
                                <div 
                                    className="absolute h-full border-l border-cyan-400/15"
                                    style={{ left: `${(i + 1) * 10}%` }}
                                />
                            </div>
                        ))}
                    </div>
                    
                    {/* Depth zone indicators */}
                    <div className="absolute left-1 top-1 text-[9px] text-cyan-300/80 font-mono space-y-4">
                        <div>0m</div>
                        <div>100m</div>
                        <div>500m</div>
                        <div>1km</div>
                        <div>2km+</div>
                    </div>
                    
                    {/* Players on minimap with enhanced styling */}
                    {Object.values(players).map((player) => {
                        const minimapX = (player.x / MAP_SIZE) * MINIMAP_SIZE;
                        const minimapY = (player.y / MAP_SIZE) * MINIMAP_SIZE;
                        const isCurrentPlayer = socketRef.current?.id === player.id;
                        
                        return (
                            <div key={`minimap-${player.id}`} className="absolute">
                                {/* Player dot with pulse animation for current player */}
                                <div
                                    className={`absolute w-3 h-3 rounded-full transform -translate-x-1.5 -translate-y-1.5 ${
                                        isCurrentPlayer 
                                            ? 'bg-yellow-400 ring-2 ring-yellow-300/60 animate-pulse' 
                                            : 'bg-red-400 ring-1 ring-red-300/60'
                                    }`}
                                    style={{
                                        left: minimapX,
                                        top: minimapY,
                                        boxShadow: isCurrentPlayer 
                                            ? '0 0 12px rgba(255, 255, 0, 0.8), 0 0 6px rgba(255, 255, 100, 0.6)' 
                                            : '0 0 8px rgba(255, 0, 0, 0.6)'
                                    }}
                                />
                                
                                {/* Player direction indicator */}
                                <div
                                    className={`absolute w-4 h-0.5 ${
                                        isCurrentPlayer ? 'bg-yellow-300' : 'bg-red-300'
                                    } transform -translate-x-2 -translate-y-0.25`}
                                    style={{
                                        left: minimapX,
                                        top: minimapY,
                                        transformOrigin: '8px 1px',
                                        transform: `translate(-8px, -1px) rotate(${player.angle}rad)`,
                                        opacity: 0.8
                                    }}
                                />
                                
                                {/* Player name on minimap */}
                                {isCurrentPlayer && (
                                    <div
                                        className="absolute text-[8px] text-yellow-200 font-bold whitespace-nowrap transform -translate-x-1/2"
                                        style={{
                                            left: minimapX,
                                            top: minimapY - 12,
                                            textShadow: '0 1px 2px rgba(0, 0, 0, 0.8)'
                                        }}
                                    >
                                        YOU
                                    </div>
                                )}
                            </div>
                        );
                    })}
                    
                    {/* Current view area indicator on minimap */}
                    {socketRef.current?.id && players[socketRef.current.id] && gameContainerRef.current && (
                        <div
                            className="absolute border-2 border-yellow-400/80 pointer-events-none rounded-sm"
                            style={{
                                // Calculate visible area on minimap based on current player position and viewport
                                left: Math.max(0, (-worldOffset.x / MAP_SIZE) * MINIMAP_SIZE),
                                top: Math.max(0, (-worldOffset.y / MAP_SIZE) * MINIMAP_SIZE),
                                width: Math.min(MINIMAP_SIZE, (viewportSize.width / MAP_SIZE) * MINIMAP_SIZE),
                                height: Math.min(MINIMAP_SIZE, (viewportSize.height / MAP_SIZE) * MINIMAP_SIZE),
                                backgroundColor: 'rgba(255, 255, 0, 0.15)',
                                boxShadow: 'inset 0 0 6px rgba(255, 255, 0, 0.3)'
                            }}
                        />
                    )}
                    
                    {/* Sonar sweep effect */}
                    <div 
                        className="absolute inset-0 pointer-events-none"
                        style={{
                            background: `conic-gradient(from 0deg, transparent 0deg, rgba(0, 255, 255, 0.1) 30deg, transparent 60deg)`,
                            animation: 'spin 4s linear infinite',
                            borderRadius: '8px'
                        }}
                    />
                </div>
                
                {/* Minimap status indicators */}
                <div className="absolute -bottom-8 left-0 text-white/70 text-[10px] font-mono space-y-0.5">
                    <div className="flex items-center gap-1">
                        <div className="w-2 h-2 bg-green-400 rounded-full animate-pulse"></div>
                        <span>ACTIVE</span>
                    </div>
                </div>
                
                <div className="absolute -bottom-8 right-0 text-white/70 text-[10px] font-mono text-right">
                    {socketRef.current?.id && players[socketRef.current.id] && (
                        <div>DEPTH: {Math.round((players[socketRef.current.id].y / MAP_SIZE) * 2000)}m</div>
                    )}
                </div>
            </div>

            {/* Enhanced Game Info HUD */}
            <div className="absolute top-4 left-4 bg-black/40 backdrop-blur-md rounded-lg p-3 border border-white/20">
                <div className="text-cyan-300 text-xs font-bold mb-2 tracking-wider">NAVIGATION DATA</div>
                <div className="text-white/90 text-sm font-mono space-y-1">
                    <div className="flex justify-between gap-4">
                        <span className="text-white/60">Ocean Zone:</span>
                        <span>{MAP_SIZE/1000}km²</span>
                    </div>
                    {socketRef.current?.id && players[socketRef.current.id] && (
                        <>
                            <div className="flex justify-between gap-4">
                                <span className="text-white/60">Position X:</span>
                                <span>{Math.round(players[socketRef.current.id].x)}m</span>
                            </div>
                            <div className="flex justify-between gap-4">
                                <span className="text-white/60">Position Y:</span>
                                <span>{Math.round(players[socketRef.current.id].y)}m</span>
                            </div>
                            <div className="flex justify-between gap-4">
                                <span className="text-white/60">Depth:</span>
                                <span className="text-blue-300">{Math.round((players[socketRef.current.id].y / MAP_SIZE) * 2000)}m</span>
                            </div>
                            <div className="flex justify-between gap-4">
                                <span className="text-white/60">Heading:</span>
                                <span>{Math.round((players[socketRef.current.id].angle || 0) * (180/Math.PI) + 180) % 360}°</span>
                            </div>
                            <div className="border-t border-white/20 pt-1 mt-2">
                                <div className="flex justify-between gap-4">
                                    <span className="text-white/60">Sharks:</span>
                                    <span className="text-yellow-300">{Object.keys(players).length}</span>
                                </div>
                                <div className="flex justify-between gap-4">
                                    <span className="text-white/60">FPS:</span>
                                    <span className={`${fpsRef.current >= 58 ? 'text-green-300' : fpsRef.current >= 45 ? 'text-yellow-300' : 'text-red-300'}`}>
                                        {Math.round(fpsRef.current)}
                                    </span>
                                </div>
                            </div>
                        </>
                    )}
                </div>
            </div>

            {/* Movement instruction overlay */}
            <div className="absolute bottom-4 left-1/2 transform -translate-x-1/2 bg-black/60 backdrop-blur-sm rounded-lg px-4 py-2 border border-white/20">
                <div className="text-white/80 text-sm font-mono text-center">
                    Move your mouse to guide the shark • Smooth and controlled swimming
                </div>
            </div>
        </div>
    );
}
