# WARP.md

This file provides guidance to WARP (warp.dev) when working with code in this repository.

## Project Overview

Jawz.io is a real-time multiplayer underwater game built with Next.js and Socket.IO where players control sharks in an ocean environment. The application features user authentication, real-time gameplay with WebSocket communication, and a persistent user storage system.

## Development Commands

### Running the Development Environment
```bash
# Run both Next.js frontend and game server concurrently
npm run dev

# Run only the Next.js frontend (port 3000)
npm run dev:next

# Run only the game server (port 3002)
npm run dev:game
# OR
npm run game-server
```

### Build and Production
```bash
# Build the Next.js application
npm run build

# Start production server
npm run start

# Run linting
npm run lint
```

### Installation
```bash
# Install dependencies
npm install
```

## Architecture Overview

### Client-Server Architecture

The application uses a dual-server architecture:

1. **Next.js Frontend Server** (Port 3000)
   - Serves the React-based UI
   - Handles user authentication and session management
   - Renders the game canvas and UI components

2. **Game Server** (Port 3002)
   - Socket.IO WebSocket server for real-time game state
   - Manages player positions, movements, and game state synchronization
   - Broadcasts updates at 20 ticks per second
   - Uses volatile messages to handle network pressure

### Key Components and Patterns

#### Frontend Architecture (`/app`, `/components`)
- **Authentication Flow**: Login/Signup → Dashboard → Game
- **Game Canvas** (`/components/game/GameCanvas.tsx`): 
  - Client-side prediction for local player movement
  - Interpolation and smoothing for remote players using Catmull-Rom splines
  - Per-frame DOM transforms for ultra-smooth 60fps rendering
  - Sophisticated camera system with smooth following
  - Depth-based visual effects and lighting

#### Backend Architecture (`/server/game`)
- **Game Server** (`/server/game/server.ts`):
  - Stateful game management with player tracking
  - Optimized network updates using dirty flag pattern
  - Map boundaries enforcement (4000x4000 pixel world)
  - Batched updates to reduce network load

#### Data Flow Patterns
1. **Client Prediction**: Local player moves immediately without server confirmation
2. **Server Reconciliation**: Server validates and broadcasts authoritative state
3. **Interpolation**: Remote players smoothly interpolated between server snapshots
4. **State Buffering**: 1.5-second history buffer for smooth remote player rendering

### Performance Optimizations

The codebase implements several performance optimizations:
- **Reduced React re-renders**: UI updates throttled to 10fps while game runs at 60fps
- **DOM transform batching**: Direct style manipulation bypasses React for smooth animation
- **Volatile Socket.IO messages**: Drops frames under pressure to maintain responsiveness
- **Compression disabled**: Trades bandwidth for reduced CPU usage
- **Offscreen culling**: Only renders visible players
- **will-change CSS**: Hardware acceleration for transforms

## Known Issues and Current Tasks

From `task.txt`:
- Game experiencing severe FPS issues (averaging 8 FPS)
- Game server running slowly after `npm run dev`
- Needs extreme interpolation implementation
- Server lag needs to be addressed

## File Structure

```
jawz.io/
├── app/                    # Next.js app directory
│   ├── page.tsx           # Main entry point with auth UI
│   └── layout.tsx         # Root layout
├── components/
│   ├── game/
│   │   └── GameCanvas.tsx # Main game rendering component
│   └── ui/                # Shadcn UI components
├── server/
│   └── game/
│       └── server.ts      # Socket.IO game server
├── lib/                   # Utility functions
│   ├── auth.ts           # Authentication logic
│   └── user-storage.ts   # User persistence
└── users/
    └── users.json        # User data storage
```

## Memory Management

Both the Next.js frontend and game server are configured to run with increased memory:
- `--max-old-space-size=4096` flag set for both processes
- This addresses potential memory pressure from real-time game state management

## WebSocket Connection

The game uses Socket.IO for real-time communication:
- Frontend connects to `http://localhost:3002`
- CORS configured for `localhost:3000` and `localhost:3001`
- Events: `player:join`, `player:move`, `players:update`, `player:left`

## Development Tips

1. **Performance Debugging**: The game tracks FPS and displays it in the HUD
2. **Network Optimization**: Server uses volatile emits and batched updates
3. **Visual Debugging**: Map boundaries and depth indicators are rendered
4. **Coordinate System**: (0,0) is top-left, map extends to (4000,4000)

## Technologies Used

- **Frontend**: Next.js 15, React 18, TypeScript, Tailwind CSS
- **Real-time**: Socket.IO for WebSocket communication
- **UI Components**: Shadcn/ui with Radix UI primitives
- **Game Rendering**: Canvas-free DOM-based rendering with CSS transforms
- **Authentication**: Custom implementation with password hashing
- **Data Storage**: File-based JSON storage for users