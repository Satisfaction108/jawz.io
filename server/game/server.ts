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

const httpServer = createServer();
const io = new Server(httpServer, {
    cors: {
        origin: "http://localhost:3000",
        methods: ["GET", "POST"]
    }
});

const gameState: GameState = {
    players: {}
};

io.on('connection', (socket) => {
    console.log('Player connected:', socket.id);

    // Initialize new player
    socket.on('player:join', (username: string) => {
        gameState.players[socket.id] = {
            id: socket.id,
            x: Math.random() * 1000, // Random spawn position
            y: Math.random() * 1000,
            angle: 0,
            username
        };
        
        // Send current game state to the new player
        socket.emit('gameState', gameState);
        // Broadcast new player to others
        socket.broadcast.emit('player:new', gameState.players[socket.id]);
    });

    // Update player position and rotation
    socket.on('player:move', ({ x, y, angle }: { x: number, y: number, angle: number }) => {
        if (gameState.players[socket.id]) {
            gameState.players[socket.id].x = x;
            gameState.players[socket.id].y = y;
            gameState.players[socket.id].angle = angle;
            socket.broadcast.emit('player:moved', {
                id: socket.id,
                x,
                y,
                angle
            });
        }
    });

    // Handle disconnection
    socket.on('disconnect', () => {
        console.log('Player disconnected:', socket.id);
        delete gameState.players[socket.id];
        io.emit('player:left', socket.id);
    });
});

const PORT = 3001;
httpServer.listen(PORT, () => {
    console.log(`Game server running on port ${PORT}`);
});
