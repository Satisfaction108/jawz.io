"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const http_1 = require("http");
const path_1 = require("path");
const fs_1 = require("fs");
const fs_2 = require("fs");
// Use environment PORT for production, fallback to 3000 for local dev
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
const HOST = process.env.HOST || '0.0.0.0';
const ROOTS = [
    (0, path_1.join)(process.cwd(), 'client'),
    (0, path_1.join)(process.cwd(), 'public'), // legacy: general static files (not sharks); sharks served from server/sharks
    (0, path_1.join)(process.cwd(), 'server'), // include server assets like /props/*
];
const USERS_FILE = (0, path_1.join)(process.cwd(), 'users', 'users.json');
const TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.ico': 'image/x-icon',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.webp': 'image/webp',
};
function tryResolve(pathname) {
    const clean = pathname.replace(/\?.*$/, '').replace(/#.*$/, '');
    // Decode percent-encoded characters so "/sharks/Baby%20Shark.png" maps to files with spaces
    let decoded = clean;
    try {
        decoded = decodeURIComponent(clean);
    }
    catch { }
    const rel = decoded.startsWith('/') ? decoded.slice(1) : decoded;
    // prevent path traversal
    const safeRel = (0, path_1.normalize)(rel).replace(/^\.\/+/, '');
    const roots = safeRel.startsWith('sharks/') ? [ROOTS[2], ROOTS[0], ROOTS[1]] : ROOTS;
    for (const root of roots) {
        const full = (0, path_1.join)(root, safeRel);
        if ((0, fs_1.existsSync)(full) && (0, fs_1.statSync)(full).isFile())
            return full;
        if ((0, fs_1.existsSync)(full) && (0, fs_1.statSync)(full).isDirectory()) {
            const idx = (0, path_1.join)(full, 'index.html');
            if ((0, fs_1.existsSync)(idx))
                return idx;
        }
    }
    // default to client/index.html for SPA-like fallback
    const fallback = (0, path_1.join)(ROOTS[0], 'index.html');
    return (0, fs_1.existsSync)(fallback) ? fallback : null;
}
async function readBody(req) {
    return await new Promise((resolve, reject) => {
        let data = '';
        req.on('data', (chunk) => (data += chunk.toString('utf8')));
        req.on('end', () => resolve(data));
        req.on('error', reject);
    });
}
async function getUsers() {
    try {
        const buf = await fs_2.promises.readFile(USERS_FILE, 'utf8');
        const arr = JSON.parse(buf);
        return Array.isArray(arr) ? arr : [];
    }
    catch {
        return [];
    }
}
async function saveUsers(users) {
    const dir = (0, path_1.join)(process.cwd(), 'users');
    try {
        await fs_2.promises.mkdir(dir, { recursive: true });
    }
    catch { }
    await fs_2.promises.writeFile(USERS_FILE, JSON.stringify(users, null, 2));
}
const server = (0, http_1.createServer)(async (req, res) => {
    const url = req.url || '/';
    const method = (req.method || 'GET').toUpperCase();
    // Simple API for users
    if (url.startsWith('/api/users')) {
        // CORS for safety (same-origin, but ok)
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        if (method === 'OPTIONS') {
            res.statusCode = 204;
            res.end();
            return;
        }
        try {
            if (method === 'GET' && url === '/api/users') {
                const users = await getUsers();
                res.setHeader('Content-Type', 'application/json; charset=utf-8');
                res.end(JSON.stringify(users));
                return;
            }
            if (method === 'POST' && url === '/api/users') {
                const raw = await readBody(req);
                const body = raw ? JSON.parse(raw) : {};
                const { username, password, timeCreated } = body || {};
                if (!username || !password) {
                    res.statusCode = 400;
                    res.end('Missing fields');
                    return;
                }
                const users = await getUsers();
                if (users.find((u) => u.username === username)) {
                    res.statusCode = 409;
                    res.end('User exists');
                    return;
                }
                const user = { username: String(username), password: String(password), timeCreated: timeCreated || new Date().toISOString() };
                users.push(user);
                await saveUsers(users);
                res.statusCode = 201;
                res.setHeader('Content-Type', 'application/json; charset=utf-8');
                res.end(JSON.stringify({ username: user.username, timeCreated: user.timeCreated }));
                return;
            }
            // PATCH /api/users/:username { password }
            if (method === 'PATCH' && /^\/api\/users\//.test(url)) {
                const target = decodeURIComponent(url.split('/').pop() || '');
                const raw = await readBody(req);
                const body = raw ? JSON.parse(raw) : {};
                const { password } = body || {};
                if (!target || !password) {
                    res.statusCode = 400;
                    res.end('Missing fields');
                    return;
                }
                const users = await getUsers();
                const idx = users.findIndex((u) => u.username === target);
                if (idx === -1) {
                    res.statusCode = 404;
                    res.end('Not found');
                    return;
                }
                users[idx].password = String(password);
                await saveUsers(users);
                res.statusCode = 200;
                res.end('OK');
                return;
            }
            res.statusCode = 404;
            res.end('Not found');
            return;
        }
        catch (err) {
            console.error('API error', err);
            res.statusCode = 500;
            res.end('Server error');
            return;
        }
    }
    // Static file serving fallback
    const file = tryResolve(url);
    if (!file) {
        res.statusCode = 404;
        res.end('Not found');
        return;
    }
    const type = TYPES[(0, path_1.extname)(file).toLowerCase()] || 'application/octet-stream';
    res.setHeader('Content-Type', type);
    (0, fs_1.createReadStream)(file).pipe(res);
});
server.listen(PORT, HOST, () => {
    console.log(`Static server + API running on ${HOST}:${PORT}`);
    console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});
