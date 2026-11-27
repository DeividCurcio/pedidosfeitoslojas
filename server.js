'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');

const ROOT = __dirname;
const PORT = Number(process.env.PORT || 3000);
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const APP_ORIGIN = (process.env.APP_ORIGIN || '').replace(/\/+$/, '');
const COOKIE_NAME = 'pedidos_session';
const SESSION_DAYS = 30;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const STORES = ['Shopee', 'Shein', 'Mercado Livre', 'Kwai', 'TikTok', 'Tik Tok J&T'];
const ORDER_ORIGINS = ['voz', 'manual', 'qr'];
const TEAM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const sessionsByTeam = new Map();
const authAttempts = new Map();

if (IS_PRODUCTION && !APP_ORIGIN) {
  throw new Error('APP_ORIGIN must be set to the public HTTPS origin in production.');
}

const dataDirectory = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));
fs.mkdirSync(dataDirectory, { recursive: true });
const database = new Database(path.join(dataDirectory, 'pedidos.sqlite'));
database.pragma('journal_mode = WAL');
database.pragma('foreign_keys = ON');
database.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL COLLATE NOCASE UNIQUE,
    display_name TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS teams (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    invite_code TEXT NOT NULL UNIQUE,
    created_by TEXT NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS memberships (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
    joined_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY,
    team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id),
    store TEXT NOT NULL,
    quantity INTEGER NOT NULL CHECK (quantity BETWEEN 1 AND 999),
    created_at TEXT NOT NULL,
    origin TEXT NOT NULL CHECK (origin IN ('voz', 'manual', 'qr'))
  );
  CREATE INDEX IF NOT EXISTS orders_team_date_idx ON orders(team_id, created_at);
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS migrations (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    imported_count INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );
`);

const queries = {
  userByEmail: database.prepare('SELECT * FROM users WHERE email = ?'),
  userById: database.prepare('SELECT id, email, display_name, created_at FROM users WHERE id = ?'),
  insertUser: database.prepare('INSERT INTO users (id, email, display_name, password_salt, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)'),
  teamForUser: database.prepare(`
    SELECT t.id, t.name, t.invite_code AS code, m.role
    FROM memberships m JOIN teams t ON t.id = m.team_id
    WHERE m.user_id = ?
  `),
  teamByCode: database.prepare('SELECT * FROM teams WHERE invite_code = ?'),
  insertTeam: database.prepare('INSERT INTO teams (id, name, invite_code, created_by, created_at) VALUES (?, ?, ?, ?, ?)'),
  insertMembership: database.prepare('INSERT INTO memberships (user_id, team_id, role, joined_at) VALUES (?, ?, ?, ?)'),
  membersForTeam: database.prepare(`
    SELECT u.id, u.display_name AS displayName, m.role
    FROM memberships m JOIN users u ON u.id = m.user_id
    WHERE m.team_id = ? ORDER BY m.joined_at, u.display_name
  `),
  ordersForTeam: database.prepare(`
    SELECT o.id, o.store, o.quantity, o.created_at AS createdAt, o.origin,
      o.user_id AS userId, u.display_name AS userName
    FROM orders o JOIN users u ON u.id = o.user_id
    WHERE o.team_id = ? ORDER BY o.created_at DESC, o.rowid DESC
  `),
  insertOrder: database.prepare('INSERT INTO orders (id, team_id, user_id, store, quantity, created_at, origin) VALUES (?, ?, ?, ?, ?, ?, ?)'),
  deleteOrder: database.prepare('DELETE FROM orders WHERE id = ? AND team_id = ?'),
  latestOrder: database.prepare('SELECT id FROM orders WHERE team_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1'),
  sessionByHash: database.prepare(`
    SELECT s.user_id AS userId, s.expires_at AS expiresAt,
      u.email, u.display_name AS displayName, u.created_at AS createdAt
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ?
  `),
  insertSession: database.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)'),
  deleteSession: database.prepare('DELETE FROM sessions WHERE token_hash = ?'),
  deleteExpiredSessions: database.prepare('DELETE FROM sessions WHERE expires_at <= ?'),
  migrationById: database.prepare('SELECT * FROM migrations WHERE id = ?'),
  insertMigration: database.prepare('INSERT INTO migrations (id, user_id, team_id, imported_count, created_at) VALUES (?, ?, ?, ?, ?)')
};

const createTeamTransaction = database.transaction((userId, name, teamId, code, now) => {
  queries.insertTeam.run(teamId, name, code, userId, now);
  queries.insertMembership.run(userId, teamId, 'owner', now);
});

const joinTeamTransaction = database.transaction((userId, teamId, now) => {
  queries.insertMembership.run(userId, teamId, 'member', now);
});

function json(res, status, value, headers) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers
  });
  res.end(JSON.stringify(value));
}

function error(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (Buffer.byteLength(body) > MAX_BODY_BYTES) {
        reject(error(413, 'O corpo da requisição excede o limite permitido.'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!body) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(error(400, 'JSON inválido.'));
      }
    });
    req.on('error', reject);
  });
}

function safeEqual(a, b) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

function createPasswordHash(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  return { salt, hash: hashPassword(password, salt) };
}

function sessionCookie(token, expiresInSeconds) {
  const attributes = [
    `${COOKIE_NAME}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${expiresInSeconds}`
  ];
  if (IS_PRODUCTION) attributes.push('Secure');
  return attributes.join('; ');
}

function clearSessionCookie() {
  const attributes = [`${COOKIE_NAME}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (IS_PRODUCTION) attributes.push('Secure');
  return attributes.join('; ');
}

function cookieValue(req, name) {
  const cookies = String(req.headers.cookie || '').split(';');
  for (const cookie of cookies) {
    const separator = cookie.indexOf('=');
    if (separator < 0) continue;
    if (cookie.slice(0, separator).trim() === name) {
      return decodeURIComponent(cookie.slice(separator + 1).trim());
    }
  }
  return '';
}

function getAuth(req) {
  const token = cookieValue(req, COOKIE_NAME);
  if (!token) return null;
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const session = queries.sessionByHash.get(tokenHash);
  if (!session) return null;
  if (Date.parse(session.expiresAt) <= Date.now()) {
    queries.deleteSession.run(tokenHash);
    return null;
  }
  return {
    id: session.userId,
    email: session.email,
    displayName: session.displayName,
    createdAt: session.createdAt,
    tokenHash
  };
}

function requireAuth(req) {
  const user = getAuth(req);
  if (!user) throw error(401, 'Entre na sua conta para continuar.');
  return user;
}

function requireTeam(userId) {
  const team = queries.teamForUser.get(userId);
  if (!team) throw error(409, 'Crie uma equipe ou entre com um código de convite.');
  return team;
}

function publicUser(user) {
  return { id: user.id, email: user.email, displayName: user.displayName, createdAt: user.createdAt };
}

function currentTeam(userId) {
  const team = queries.teamForUser.get(userId);
  return team ? { id: team.id, name: team.name, code: team.code, role: team.role } : null;
}

function onlineUserIds(teamId) {
  const connected = sessionsByTeam.get(teamId);
  return connected ? new Set(Array.from(connected.values(), connection => connection.userId)) : new Set();
}

function teamSnapshot(teamId) {
  const team = database.prepare('SELECT id, name, invite_code AS code FROM teams WHERE id = ?').get(teamId);
  if (!team) return null;
  const online = onlineUserIds(teamId);
  const members = queries.membersForTeam.all(teamId).map(member => ({
    id: member.id,
    displayName: member.displayName,
    role: member.role,
    online: online.has(member.id)
  }));
  const orders = queries.ordersForTeam.all(teamId);
  return { team, members, orders };
}

function sendEvent(res, name, payload) {
  res.write(`event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`);
}

function broadcastTeam(teamId) {
  const connections = sessionsByTeam.get(teamId);
  if (!connections || connections.size === 0) return;
  const snapshot = teamSnapshot(teamId);
  if (!snapshot) return;
  for (const connection of connections.values()) {
    if (!connection.res.destroyed) sendEvent(connection.res, 'snapshot', snapshot);
  }
}

function newInviteCode() {
  let code = '';
  for (let index = 0; index < 6; index++) {
    code += TEAM_CODE_ALPHABET[crypto.randomInt(TEAM_CODE_ALPHABET.length)];
  }
  return code;
}

function clientIp(req) {
  if (TRUST_PROXY && typeof req.headers['x-forwarded-for'] === 'string') {
    return req.headers['x-forwarded-for'].split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

function allowAuthAttempt(req, res) {
  const now = Date.now();
  const key = clientIp(req);
  const attempts = authAttempts.get(key) || { count: 0, resetAt: now + 60_000 };
  if (now >= attempts.resetAt) {
    attempts.count = 0;
    attempts.resetAt = now + 60_000;
  }
  attempts.count += 1;
  authAttempts.set(key, attempts);
  if (attempts.count > 12) {
    json(res, 429, { error: 'Muitas tentativas. Aguarde um minuto antes de tentar novamente.' }, {
      'Retry-After': String(Math.max(1, Math.ceil((attempts.resetAt - now) / 1000)))
    });
    return false;
  }
  return true;
}

function verifyRequestOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) throw error(403, 'Origem não autorizada.');
  const allowed = APP_ORIGIN
    ? origin === APP_ORIGIN
    : origin === `http://localhost:${PORT}` || origin === `http://127.0.0.1:${PORT}`;
  if (!allowed) throw error(403, 'Origem não autorizada.');
}

function validateUserFields(body, registering) {
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  const displayName = typeof body.displayName === 'string' ? body.displayName.trim() : '';
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw error(400, 'Informe um e-mail válido.');
  }
  if (password.length < 10 || password.length > 128) {
    throw error(400, 'A senha deve ter entre 10 e 128 caracteres.');
  }
  if (registering && (displayName.length < 2 || displayName.length > 60)) {
    throw error(400, 'Informe um nome entre 2 e 60 caracteres.');
  }
  return { email, password, displayName };
}

function createLoginSession(res, user) {
  const token = crypto.randomBytes(32).toString('base64url');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  queries.insertSession.run(tokenHash, user.id, expiresAt);
  res.setHeader('Set-Cookie', sessionCookie(token, SESSION_DAYS * 24 * 60 * 60));
}

function validateOrder(body) {
  if (!STORES.includes(body.store)) throw error(400, 'Loja inválida.');
  if (!Number.isInteger(body.quantity) || body.quantity < 1 || body.quantity > 999) {
    throw error(400, 'A quantidade deve ser um inteiro entre 1 e 999.');
  }
  if (!ORDER_ORIGINS.includes(body.origin)) throw error(400, 'Origem do lançamento inválida.');
}

function registerOrder(teamId, userId, order, createdAt) {
  const id = crypto.randomUUID();
  queries.insertOrder.run(id, teamId, userId, order.store, order.quantity, createdAt, order.origin);
  return id;
}

function sendApp(res) {
  const file = path.join(ROOT, 'index.html');
  const contents = fs.readFileSync(file);
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    'X-Frame-Options': 'DENY',
    'Permissions-Policy': 'camera=(self), microphone=(self)'
  });
  res.end(contents);
}

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const { pathname } = url;

  if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
    sendApp(res);
    return;
  }
  if (req.method === 'GET' && pathname === '/api/health') {
    json(res, 200, { ok: true });
    return;
  }
  if (!pathname.startsWith('/api/')) {
    json(res, 404, { error: 'Rota não encontrada.' });
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') verifyRequestOrigin(req);

  if (req.method === 'POST' && (pathname === '/api/auth/register' || pathname === '/api/auth/login')) {
    if (!allowAuthAttempt(req, res)) return;
    const body = await readJson(req);
    const isRegister = pathname.endsWith('/register');
    const fields = validateUserFields(body, isRegister);
    let user;

    if (isRegister) {
      const { salt, hash } = createPasswordHash(fields.password);
      const row = {
        id: crypto.randomUUID(),
        email: fields.email,
        displayName: fields.displayName,
        createdAt: new Date().toISOString()
      };
      try {
        queries.insertUser.run(row.id, row.email, row.displayName, salt, hash, row.createdAt);
      } catch (err) {
        if (String(err.code || '').startsWith('SQLITE_CONSTRAINT')) throw error(409, 'Já existe uma conta com este e-mail.');
        throw err;
      }
      user = row;
    } else {
      const stored = queries.userByEmail.get(fields.email);
      const candidate = stored ? hashPassword(fields.password, stored.password_salt) : crypto.randomBytes(64).toString('hex');
      if (!stored || !safeEqual(candidate, stored.password_hash)) {
        throw error(401, 'E-mail ou senha inválidos.');
      }
      user = {
        id: stored.id,
        email: stored.email,
        displayName: stored.display_name,
        createdAt: stored.created_at
      };
    }

    createLoginSession(res, user);
    json(res, isRegister ? 201 : 200, { user: publicUser(user), team: currentTeam(user.id) });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/auth/logout') {
    const user = getAuth(req);
    if (user) queries.deleteSession.run(user.tokenHash);
    res.setHeader('Set-Cookie', clearSessionCookie());
    json(res, 200, { ok: true });
    return;
  }

  if (req.method === 'GET' && pathname === '/api/me') {
    const user = requireAuth(req);
    json(res, 200, { user: publicUser(user), team: currentTeam(user.id) });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/teams') {
    const user = requireAuth(req);
    if (currentTeam(user.id)) throw error(409, 'Sua conta já pertence a uma equipe.');
    const body = await readJson(req);
    const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : 'Equipe de empacotamento';
    if (name.length > 60) throw error(400, 'O nome da equipe deve ter no máximo 60 caracteres.');
    let teamId;
    let code;
    for (let attempt = 0; attempt < 5; attempt++) {
      teamId = crypto.randomUUID();
      code = newInviteCode();
      try {
        createTeamTransaction(user.id, name, teamId, code, new Date().toISOString());
        break;
      } catch (err) {
        if (attempt === 4 || !String(err.code || '').startsWith('SQLITE_CONSTRAINT_UNIQUE')) throw err;
      }
    }
    json(res, 201, { team: currentTeam(user.id), snapshot: teamSnapshot(teamId) });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/teams/join') {
    if (!allowAuthAttempt(req, res)) return;
    const user = requireAuth(req);
    if (currentTeam(user.id)) throw error(409, 'Sua conta já pertence a uma equipe.');
    const body = await readJson(req);
    const code = typeof body.code === 'string' ? body.code.trim().toUpperCase() : '';
    if (!/^[A-HJ-NP-Z2-9]{6}$/.test(code)) throw error(400, 'Digite o código de convite de 6 caracteres.');
    const team = queries.teamByCode.get(code);
    if (!team) throw error(404, 'Código de equipe não encontrado.');
    try {
      joinTeamTransaction(user.id, team.id, new Date().toISOString());
    } catch (err) {
      if (String(err.code || '').startsWith('SQLITE_CONSTRAINT')) throw error(409, 'Sua conta já participa de uma equipe.');
      throw err;
    }
    broadcastTeam(team.id);
    json(res, 200, { team: currentTeam(user.id), snapshot: teamSnapshot(team.id) });
    return;
  }

  if (req.method === 'GET' && pathname === '/api/team') {
    const user = requireAuth(req);
    const team = requireTeam(user.id);
    json(res, 200, teamSnapshot(team.id));
    return;
  }

  if (req.method === 'GET' && pathname === '/api/events') {
    const user = requireAuth(req);
    const team = requireTeam(user.id);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
      'X-Content-Type-Options': 'nosniff'
    });
    res.write('retry: 3000\n\n');
    const connection = { res, userId: user.id };
    if (!sessionsByTeam.has(team.id)) sessionsByTeam.set(team.id, new Set());
    sessionsByTeam.get(team.id).add(connection);
    sendEvent(res, 'snapshot', teamSnapshot(team.id));
    broadcastTeam(team.id);
    const heartbeat = setInterval(() => {
      if (!res.destroyed) res.write(': heartbeat\n\n');
    }, 20_000);
    res.on('close', () => {
      clearInterval(heartbeat);
      const connections = sessionsByTeam.get(team.id);
      if (!connections) return;
      connections.delete(connection);
      if (connections.size === 0) sessionsByTeam.delete(team.id);
      else broadcastTeam(team.id);
    });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/orders/import') {
    const user = requireAuth(req);
    const team = requireTeam(user.id);
    const body = await readJson(req);
    const migrationId = typeof body.migrationId === 'string' ? body.migrationId : '';
    const items = body.items;
    if (!/^[a-zA-Z0-9-]{16,80}$/.test(migrationId)) throw error(400, 'Identificador de importação inválido.');
    if (!Array.isArray(items) || items.length > 10_000) throw error(400, 'A importação deve conter até 10.000 lançamentos.');
    const previous = queries.migrationById.get(migrationId);
    if (previous) {
      if (previous.team_id !== team.id) throw error(409, 'Este identificador já foi usado em outra equipe.');
      json(res, 200, { imported: previous.imported_count, alreadyImported: true });
      return;
    }
    const parsedItems = items.map(item => {
      if (!item || !STORES.includes(item.store) || !Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 999 ||
        !ORDER_ORIGINS.includes(item.origin) || typeof item.createdAt !== 'string' || !Number.isFinite(Date.parse(item.createdAt))) {
        throw error(400, 'A importação contém um lançamento inválido.');
      }
      return { store: item.store, quantity: item.quantity, origin: item.origin, createdAt: new Date(item.createdAt).toISOString() };
    });
    const doImport = database.transaction(() => {
      for (const item of parsedItems) registerOrder(team.id, user.id, item, item.createdAt);
      queries.insertMigration.run(migrationId, user.id, team.id, parsedItems.length, new Date().toISOString());
    });
    doImport();
    broadcastTeam(team.id);
    json(res, 201, { imported: parsedItems.length, alreadyImported: false });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/orders') {
    const user = requireAuth(req);
    const team = requireTeam(user.id);
    const body = await readJson(req);
    validateOrder(body);
    const id = registerOrder(team.id, user.id, body, new Date().toISOString());
    broadcastTeam(team.id);
    json(res, 201, { order: queries.ordersForTeam.all(team.id).find(order => order.id === id) });
    return;
  }

  if (req.method === 'DELETE' && pathname === '/api/orders/latest') {
    const user = requireAuth(req);
    const team = requireTeam(user.id);
    const latest = queries.latestOrder.get(team.id);
    if (!latest) throw error(404, 'Não há lançamentos para desfazer.');
    queries.deleteOrder.run(latest.id, team.id);
    broadcastTeam(team.id);
    json(res, 200, { deletedId: latest.id });
    return;
  }

  const orderMatch = pathname.match(/^\/api\/orders\/([^/]+)$/);
  if (req.method === 'DELETE' && orderMatch) {
    const user = requireAuth(req);
    const team = requireTeam(user.id);
    const id = decodeURIComponent(orderMatch[1]);
    const result = queries.deleteOrder.run(id, team.id);
    if (!result.changes) throw error(404, 'Lançamento não encontrado nesta equipe.');
    broadcastTeam(team.id);
    json(res, 200, { deletedId: id });
    return;
  }

  if (req.method === 'GET' && pathname === '/api/orders') {
    const user = requireAuth(req);
    const team = requireTeam(user.id);
    json(res, 200, { orders: queries.ordersForTeam.all(team.id) });
    return;
  }

  json(res, 404, { error: 'Rota não encontrada.' });
}

if (IS_PRODUCTION && !APP_ORIGIN.startsWith('https://')) {
  throw new Error('APP_ORIGIN must use HTTPS in production.');
}

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch(err => {
    if (res.headersSent) {
      res.end();
      return;
    }
    const status = Number.isInteger(err.status) ? err.status : 500;
    if (status >= 500) console.error(err);
    json(res, status, { error: status === 500 ? 'Erro interno do servidor.' : err.message });
  });
});

const expiration = setInterval(() => {
  queries.deleteExpiredSessions.run(new Date().toISOString());
  const now = Date.now();
  for (const [ip, record] of authAttempts) {
    if (now >= record.resetAt) authAttempts.delete(ip);
  }
}, 60_000);
expiration.unref();

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Controle de Pedidos API disponível em http://localhost:${PORT}`);
  console.log(`Banco SQLite: ${path.join(dataDirectory, 'pedidos.sqlite')}`);
});

function shutdown() {
  for (const connections of sessionsByTeam.values()) {
    for (const connection of connections) connection.res.end();
  }
  sessionsByTeam.clear();
  server.close(() => {
    database.close();
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
