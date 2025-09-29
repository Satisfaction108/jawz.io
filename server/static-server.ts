import { createServer } from 'http';
import { extname, join, normalize } from 'path';
import { createReadStream, existsSync, statSync } from 'fs';
import { promises as fsp } from 'fs';

const PORT = 3000;
const ROOTS = [
  join(process.cwd(), 'client'),
  join(process.cwd(), 'public'), // legacy: general static files (not sharks); sharks served from server/sharks
  join(process.cwd(), 'server'), // include server assets like /props/*
];

const USERS_FILE = join(process.cwd(), 'users', 'users.json');

const TYPES: Record<string, string> = {
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

function tryResolve(pathname: string): string | null {
  const clean = pathname.replace(/\?.*$/, '').replace(/#.*$/, '');
  // Decode percent-encoded characters so "/sharks/Baby%20Shark.png" maps to files with spaces
  let decoded = clean;
  try { decoded = decodeURIComponent(clean); } catch {}
  const rel = decoded.startsWith('/') ? decoded.slice(1) : decoded;
  // prevent path traversal
  const safeRel = normalize(rel).replace(/^\.\/+/, '');

  const roots = safeRel.startsWith('sharks/') ? [ROOTS[2], ROOTS[0], ROOTS[1]] : ROOTS;
  for (const root of roots) {
    const full = join(root, safeRel);
    if (existsSync(full) && statSync(full).isFile()) return full;
    if (existsSync(full) && statSync(full).isDirectory()) {
      const idx = join(full, 'index.html');
      if (existsSync(idx)) return idx;
    }
  }
  // default to client/index.html for SPA-like fallback
  const fallback = join(ROOTS[0], 'index.html');
  return existsSync(fallback) ? fallback : null;
}

async function readBody(req: any): Promise<string> {
  return await new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk: Buffer) => (data += chunk.toString('utf8')));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

async function getUsers(): Promise<any[]> {
  try {
    const buf = await fsp.readFile(USERS_FILE, 'utf8');
    const arr = JSON.parse(buf);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

async function saveUsers(users: any[]): Promise<void> {
  const dir = join(process.cwd(), 'users');
  try { await fsp.mkdir(dir, { recursive: true }); } catch {}
  await fsp.writeFile(USERS_FILE, JSON.stringify(users, null, 2));
}

const server = createServer(async (req, res) => {
  const url = req.url || '/';
  const method = (req.method || 'GET').toUpperCase();

  // Simple API for users
  if (url.startsWith('/api/users')) {
    // CORS for safety (same-origin, but ok)
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }

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
        if (!username || !password) { res.statusCode = 400; res.end('Missing fields'); return; }
        const users = await getUsers();
        if (users.find((u) => u.username === username)) { res.statusCode = 409; res.end('User exists'); return; }
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
        if (!target || !password) { res.statusCode = 400; res.end('Missing fields'); return; }
        const users = await getUsers();
        const idx = users.findIndex((u) => u.username === target);
        if (idx === -1) { res.statusCode = 404; res.end('Not found'); return; }
        users[idx].password = String(password);
        await saveUsers(users);
        res.statusCode = 200;
        res.end('OK');
        return;
      }

      res.statusCode = 404; res.end('Not found'); return;
    } catch (err) {
      console.error('API error', err);
      res.statusCode = 500; res.end('Server error'); return;
    }
  }

  // Static file serving fallback
  const file = tryResolve(url);
  if (!file) {
    res.statusCode = 404;
    res.end('Not found');
    return;
  }
  const type = TYPES[extname(file).toLowerCase()] || 'application/octet-stream';
  res.setHeader('Content-Type', type);
  createReadStream(file).pipe(res);
});

server.listen(PORT, () => {
  console.log(`Static server + API running at http://localhost:${PORT}`);
});

