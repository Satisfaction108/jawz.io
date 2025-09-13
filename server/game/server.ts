import { Server } from 'socket.io';
import { createServer } from 'http';

interface Player {
    id: string;
    x: number;
    y: number;
    angle: number;
    username: string;
}

interface GameState {
    players: { [key: string]: Player };
}

// Map configuration
const MAP_SIZE = 4000;

const httpServer = createServer();
const io = new Server(httpServer, {
    cors: {
        origin: ["http://localhost:3000", "http://localhost:3001"],
        methods: ["GET", "POST"]
    }
});

const gameState: GameState = {
    players: {}
};
// Track whether the state changed since last tick to avoid redundant broadcasts
let dirty = false;

io.on('connection', (socket) => {
    console.log('Player connected:', socket.id);

    // Initialize new player
    socket.on('player:join', (username: string) => {
        // Spawn players in the upper portion of the map (shallow water)
        gameState.players[socket.id] = {
            id: socket.id,
            x: Math.random() * (MAP_SIZE - 200) + 100, // Random spawn position with margins
            y: Math.random() * (MAP_SIZE * 0.3) + 100, // Spawn in top 30% of map (shallow water)
            angle: 0,
            username
        };
        
        console.log(`Player ${username} spawned at (${gameState.players[socket.id].x}, ${gameState.players[socket.id].y})`);
        
        // Send current game state to the new player (include server timestamp for smoother client interpolation)
        socket.emit('gameState', { ts: Date.now(), players: gameState.players });
        // Broadcast new player to others
        dirty = true;
        socket.broadcast.emit('player:new', gameState.players[socket.id]);
    });

    // Update player position and rotation
    socket.on('player:move', ({ x, y, angle }: { x: number, y: number, angle: number }) => {
        if (gameState.players[socket.id]) {
            // Clamp coordinates to map boundaries
            const clampedX = Math.max(0, Math.min(MAP_SIZE - 100, x));
            const clampedY = Math.max(0, Math.min(MAP_SIZE - 100, y));
            
            gameState.players[socket.id].x = clampedX;
            gameState.players[socket.id].y = clampedY;
            gameState.players[socket.id].angle = angle;
            // Mark state as changed; broadcast occurs on the server tick (reduces network/CPU)
            dirty = true;
            // No immediate broadcast; updates are sent on the server tick below to reduce network load
        }
    });

    // Handle disconnection
    socket.on('disconnect', () => {
        console.log('Player disconnected:', socket.id);
        delete gameState.players[socket.id];
        dirty = true;
        io.emit('player:left', socket.id);
    });
});

// Broadcast players at a fixed tick rate using volatile messages (drops frames under pressure)
const TICK_MS = 50; // 20 ticks per second
setInterval(() => {
    if (!dirty) return; // Skip if no changes; reduces bandwidth and CPU
    dirty = false;
    // Send only players; include a timestamp for client-side interpolation; disable compression to save CPU
    io.volatile.compress(false).emit('players:update', { ts: Date.now(), players: gameState.players });
}, TICK_MS);

const PORT = 3002;
httpServer.listen(PORT, () => {
    console.log(`Game server running on port ${PORT}`);
    console.log(`Map size: ${MAP_SIZE}x${MAP_SIZE} pixels`);
});
