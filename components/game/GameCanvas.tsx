import { useEffect, useRef, useState } from 'react';
import { io, Socket } from 'socket.io-client';
import Image from 'next/image';

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

export default function GameCanvas({ username }: { username: string }) {
    const socketRef = useRef<Socket>();
    const [players, setPlayers] = useState<{ [key: string]: Player }>({});
    const gameContainerRef = useRef<HTMLDivElement>(null);
    const playerRef = useRef<Player>();

    useEffect(() => {
        // Connect to game server
        socketRef.current = io('http://localhost:3001');
        const socket = socketRef.current;

        // Join the game
        socket.emit('player:join', username);

        // Handle initial game state
        socket.on('gameState', (gameState: GameState) => {
            setPlayers(gameState.players);
        });

        // Handle new player joining
        socket.on('player:new', (player: Player) => {
            setPlayers(prev => ({ ...prev, [player.id]: player }));
        });

        // Handle player movements
        socket.on('player:moved', ({ id, x, y, angle }: Player) => {
            setPlayers(prev => ({
                ...prev,
                [id]: { ...prev[id], x, y, angle }
            }));
        });

        // Handle player leaving
        socket.on('player:left', (playerId: string) => {
            setPlayers(prev => {
                const newPlayers = { ...prev };
                delete newPlayers[playerId];
                return newPlayers;
            });
        });

        return () => {
            socket.disconnect();
        };
    }, [username]);

    // Handle mouse movement
    useEffect(() => {
        const handleMouseMove = (e: MouseEvent) => {
            if (!gameContainerRef.current || !socketRef.current || !playerRef.current) return;

            const container = gameContainerRef.current;
            const rect = container.getBoundingClientRect();
            
            // Calculate center of the player
            const playerCenterX = playerRef.current.x + 50; // assuming shark image is 100px wide
            const playerCenterY = playerRef.current.y + 50; // assuming shark image is 100px tall
            
            // Calculate angle between player center and mouse position
            const dx = e.clientX - rect.left - playerCenterX;
            const dy = e.clientY - rect.top - playerCenterY;
            const angle = Math.atan2(dy, dx);

            // Update local player position
            const speed = 5;
            const newX = playerRef.current.x + Math.cos(angle) * speed;
            const newY = playerRef.current.y + Math.sin(angle) * speed;

            // Update server
            socketRef.current.emit('player:move', {
                x: newX,
                y: newY,
                angle: angle
            });

            // Update local state
            setPlayers(prev => ({
                ...prev,
                [socketRef.current!.id]: {
                    ...prev[socketRef.current!.id],
                    x: newX,
                    y: newY,
                    angle: angle
                }
            }));
        };

        const container = gameContainerRef.current;
        if (container) {
            container.addEventListener('mousemove', handleMouseMove);
        }

        return () => {
            if (container) {
                container.removeEventListener('mousemove', handleMouseMove);
            }
        };
    }, []);

    // Store the current player's reference
    useEffect(() => {
        if (socketRef.current && players[socketRef.current.id]) {
            playerRef.current = players[socketRef.current.id];
        }
    }, [players]);

    return (
        <div 
            ref={gameContainerRef}
            className="relative w-full h-screen bg-blue-900 overflow-hidden"
            style={{
                background: 'linear-gradient(180deg, #0077be 0%, #003366 100%)'
            }}
        >
            {/* Underwater effects */}
            <div className="absolute inset-0 opacity-30">
                <div className="animate-bubble absolute w-4 h-4 bg-white rounded-full" style={{ left: '10%', animationDelay: '0s' }} />
                <div className="animate-bubble absolute w-3 h-3 bg-white rounded-full" style={{ left: '20%', animationDelay: '2s' }} />
                <div className="animate-bubble absolute w-5 h-5 bg-white rounded-full" style={{ left: '35%', animationDelay: '1s' }} />
                <div className="animate-bubble absolute w-4 h-4 bg-white rounded-full" style={{ left: '50%', animationDelay: '3s' }} />
                <div className="animate-bubble absolute w-3 h-3 bg-white rounded-full" style={{ left: '65%', animationDelay: '2.5s' }} />
                <div className="animate-bubble absolute w-4 h-4 bg-white rounded-full" style={{ left: '80%', animationDelay: '1.5s' }} />
                <div className="animate-bubble absolute w-5 h-5 bg-white rounded-full" style={{ left: '90%', animationDelay: '0.5s' }} />
            </div>

            {/* Render all players */}
            {Object.values(players).map((player) => (
                <div
                    key={player.id}
                    className="absolute"
                    style={{
                        left: player.x,
                        top: player.y,
                        transform: `rotate(${player.angle}rad)`,
                        transition: 'transform 0.1s ease-out'
                    }}
                >
                    <Image
                        src="/server/sharks/babyshark.png"
                        alt="Shark"
                        width={100}
                        height={100}
                        className="transition-transform"
                    />
                    <div className="absolute -top-6 left-1/2 transform -translate-x-1/2 text-white text-sm whitespace-nowrap">
                        {player.username}
                    </div>
                </div>
            ))}
        </div>
    );
}
