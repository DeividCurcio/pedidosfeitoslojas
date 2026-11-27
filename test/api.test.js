'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { after, before, test } = require('node:test');

const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'pedidos-api-test-'));
let server;
let origin;

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function reservePort() {
  const listener = net.createServer();
  await new Promise((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', resolve);
  });
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  return port;
}

async function request(client, pathname, method, body) {
  const headers = { Origin: origin };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (client.cookie) headers.Cookie = client.cookie;
  const response = await fetch(origin + pathname, {
    method: method || 'GET',
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const setCookie = response.headers.get('set-cookie');
  if (setCookie) client.cookie = setCookie.split(';', 1)[0];
  const payload = await response.json();
  return { response, payload };
}

async function nextEvent(reader, state) {
  const decoder = new TextDecoder();
  while (true) {
    const boundary = state.buffer.indexOf('\n\n');
    if (boundary >= 0) {
      const frame = state.buffer.slice(0, boundary);
      state.buffer = state.buffer.slice(boundary + 2);
      const event = frame.match(/^event: ([^\r\n]+)/m);
      const data = frame.match(/^data: (.+)$/m);
      if (event && data) return { event: event[1], data: JSON.parse(data[1]) };
      continue;
    }
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out waiting for an SSE event.')), 4_000);
      reader.read().then(value => {
        clearTimeout(timer);
        resolve(value);
      }, err => {
        clearTimeout(timer);
        reject(err);
      });
    });
    if (result.done) throw new Error('The SSE stream closed unexpectedly.');
    state.buffer += decoder.decode(result.value, { stream: true });
  }
}

before(async () => {
  const port = await reservePort();
  origin = `http://localhost:${port}`;
  server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDirectory, NODE_ENV: 'test' },
    stdio: 'ignore'
  });
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      const response = await fetch(origin + '/api/health');
      if (response.ok) return;
    } catch (error) {
      await wait(100);
    }
  }
  throw new Error('The API did not become ready.');
});

after(async () => {
  if (server && server.exitCode === null) {
    const exited = new Promise(resolve => server.once('exit', resolve));
    server.kill();
    await exited;
  }
  fs.rmSync(dataDirectory, { recursive: true, force: true });
});

test('accounts share team orders and live snapshots while preserving import idempotency', async () => {
  const owner = {};
  const member = {};
  const suffix = Date.now();
  const ownerSignup = await request(owner, '/api/auth/register', 'POST', {
    displayName: 'Empacotadora Ana',
    email: `ana-${suffix}@example.test`,
    password: 'senha-segura-123'
  });
  assert.equal(ownerSignup.response.status, 201);
  assert.ok(owner.cookie);

  const created = await request(owner, '/api/teams', 'POST', { name: 'Equipe da manhã' });
  assert.equal(created.response.status, 201);
  assert.match(created.payload.team.code, /^[A-HJ-NP-Z2-9]{6}$/);

  const imported = await request(owner, '/api/orders/import', 'POST', {
    migrationId: `migration-test-${suffix}`,
    items: [{ store: 'Tik Tok J&T', quantity: 2, createdAt: new Date().toISOString(), origin: 'manual' }]
  });
  assert.equal(imported.response.status, 201);
  assert.equal(imported.payload.imported, 1);
  const repeatedImport = await request(owner, '/api/orders/import', 'POST', {
    migrationId: `migration-test-${suffix}`,
    items: [{ store: 'Tik Tok J&T', quantity: 2, createdAt: new Date().toISOString(), origin: 'manual' }]
  });
  assert.equal(repeatedImport.payload.alreadyImported, true);

  const memberSignup = await request(member, '/api/auth/register', 'POST', {
    displayName: 'Empacotador Bruno',
    email: `bruno-${suffix}@example.test`,
    password: 'outra-senha-123'
  });
  assert.equal(memberSignup.response.status, 201);
  const joined = await request(member, '/api/teams/join', 'POST', { code: created.payload.team.code.toLowerCase() });
  assert.equal(joined.response.status, 200);
  assert.equal(joined.payload.snapshot.orders[0].userName, 'Empacotadora Ana');
  const sharedBackupReplay = await request(member, '/api/orders/import', 'POST', {
    migrationId: `migration-test-${suffix}`,
    items: [{ store: 'Tik Tok J&T', quantity: 2, createdAt: new Date().toISOString(), origin: 'manual' }]
  });
  assert.equal(sharedBackupReplay.payload.alreadyImported, true);
  const memberImport = await request(member, '/api/orders/import', 'POST', {
    migrationId: `member-import-${suffix}`,
    items: [{ store: 'Shein', quantity: 1, createdAt: new Date().toISOString(), origin: 'voz' }]
  });
  assert.equal(memberImport.response.status, 201);

  const streamResponse = await fetch(origin + '/api/events', {
    headers: { Cookie: member.cookie }
  });
  assert.equal(streamResponse.status, 200);
  const reader = streamResponse.body.getReader();
  const streamState = { buffer: '' };
  let event = await nextEvent(reader, streamState);
  assert.equal(event.event, 'snapshot');

  const createdOrder = await request(owner, '/api/orders', 'POST', {
    store: 'Tik Tok J&T',
    quantity: 3,
    origin: 'qr'
  });
  assert.equal(createdOrder.response.status, 201);
  assert.equal(createdOrder.payload.order.userName, 'Empacotadora Ana');

  let update;
  for (let attempt = 0; attempt < 4; attempt++) {
    update = await nextEvent(reader, streamState);
    if (update.data.orders.some(order => order.id === createdOrder.payload.order.id)) break;
  }
  assert.ok(update.data.orders.some(order => order.id === createdOrder.payload.order.id));
  assert.ok(update.data.members.some(person => person.displayName === 'Empacotador Bruno' && person.online));

  await reader.cancel();
  const teamOrders = await request(member, '/api/orders', 'GET');
  assert.equal(teamOrders.payload.orders.length, 3);
  const removed = await request(owner, '/api/orders/latest', 'DELETE');
  assert.equal(removed.response.status, 200);
  const afterUndo = await request(member, '/api/orders', 'GET');
  assert.equal(afterUndo.payload.orders.length, 2);
  assert.ok(afterUndo.payload.orders.some(order => order.store === 'Tik Tok J&T'));
  assert.ok(afterUndo.payload.orders.some(order => order.store === 'Shein'));
});

test('state-changing requests reject cross-origin requests', async () => {
  const response = await fetch(origin + '/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://attacker.example' },
    body: JSON.stringify({ displayName: 'Pessoa', email: 'bad@example.test', password: 'senha-segura-123' })
  });
  assert.equal(response.status, 403);
});
