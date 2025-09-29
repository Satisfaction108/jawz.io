# Jawz.io (Static HTML + TypeScript)

Next.js has been fully removed. The project now serves a static client (HTML/CSS/TypeScript) and a separate Socket.IO game server.

## Dev quickstart

1. Install deps (once):

   npm install

2. Build client (creates client/dist):

   npm run build

3. Run dev (client watcher + static server + game server):

   npm run dev

- Static client: http://localhost:3000
- Game server (Socket.IO): http://localhost:3002

## Project structure
- client/index.html: Landing + game UI
- client/styles.css: Underwater theme styles (no Tailwind)
- client/main.ts: Game client (Socket.IO, movement, rendering)
- server/sharks: Shark image assets (served under /sharks)
- server/game/server.ts: Socket.IO server (unchanged)
- server/static-server.ts: Minimal TypeScript static file server

## Notes
- If you change client/main.ts, the dev watcher re-compiles to client/dist automatically.
- The client connects to ws at http://localhost:3002.
