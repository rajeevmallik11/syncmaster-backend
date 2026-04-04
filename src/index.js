import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { PrismaClient } from '@prisma/client';
import Redis from 'ioredis';
import { WebSocketServer } from 'ws';
import { sessionRoutes } from './routes/sessions.js';
import { deviceRoutes } from './routes/devices.js';
import { groupRoutes } from './routes/groups.js';
import { commandRoutes } from './routes/commands.js';
import { websocketHandler, broadcastToSession, send } from './services/websocket.js';
import { sessionManager } from './services/sessionManager.js';

const APP_PORT = 8080;
const REDIS_URL = process.env.REDIS_URL;
const JWT_SECRET = process.env.JWT_SECRET || 'change-this-in-production';
const RAILWAY_PORT = parseInt(process.env.PORT) || APP_PORT;

console.log('=== SyncMaster Backend Starting ===');
console.log(`App port: ${APP_PORT}`);
console.log(`Railway port: ${RAILWAY_PORT}`);
console.log(`REDIS_URL: ${REDIS_URL ? 'SET' : 'NOT SET'}`);

const prisma = new PrismaClient({
  log: ['error']
});

const createMockRedis = () => {
  const store = new Map();
  const hashStore = new Map();
  const listStore = new Map();

  return {
    get: async (key) => store.get(key) || null,
    set: async (key, value) => { store.set(key, value); return 'OK'; },
    setex: async (key, ttl, value) => { store.set(key, value); return 'OK'; },
    setnx: async (key, value) => { store.set(key, value); return 1; },
    del: async (...keys) => { let count = 0; keys.forEach(k => { if (store.delete(k)) count++; }); return count; },
    exists: async (...keys) => keys.filter(k => store.has(k)).length,
    expire: async () => 1,
    ttl: async () => -1,
    ping: async () => 'PONG',
    quit: async () => { },
    disconnect: async () => { },
    connect: async () => { },
    hset: async (key, field, value) => { if (!hashStore.has(key)) hashStore.set(key, new Map()); hashStore.get(key).set(field, value); return 1; },
    hget: async (key, field) => hashStore.get(key)?.get(field) || null,
    hdel: async (key, ...fields) => { const hs = hashStore.get(key); if (!hs) return 0; let count = 0; fields.forEach(f => { if (hs.delete(f)) count++; }); return count; },
    lpush: async (key, ...values) => { if (!listStore.has(key)) listStore.set(key, []); listStore.get(key).unshift(...values); return listStore.get(key).length; },
    ltrim: async (key, start, end) => { const list = listStore.get(key); if (list) list.splice(end + 1); return 'OK'; },
    lrange: async (key, start, end) => { const list = listStore.get(key) || []; return list.slice(start, end + 1); },
    keys: async (pattern) => {
      const regex = new RegExp('^' + pattern.replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
      return [...store.keys(), ...hashStore.keys(), ...listStore.keys()].filter(k => regex.test(k));
    },
    status: 'ready',
    on: () => ({ on: () => { } }),
    once: () => ({ on: () => { } })
  };
};

let redis;

if (REDIS_URL) {
  try {
    redis = new Redis(REDIS_URL, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      connectTimeout: 5000,
      retryStrategy: () => null,
      enableOfflineQueue: false
    });

    redis.on('error', (err) => console.error('Redis error:', err.message));
  } catch (e) {
    console.error('Redis init failed, using mock:', e.message);
    redis = createMockRedis();
  }
} else {
  redis = createMockRedis();
  console.log('Redis: using in-memory fallback');
}

const connections = new Map();

const fastify = Fastify({
  logger: false,
  trustProxy: true
});

fastify.setErrorHandler((error, request, reply) => {
  console.error('Error:', error.message);
  reply.status(500).send({ error: 'INTERNAL_ERROR', message: 'Internal Server Error' });
});

fastify.get('/', async (request, reply) => {
  reply.send({ status: 'ok', message: 'SyncMaster Backend is running' });
});

fastify.get('/health', async (request, reply) => {
  reply.send({ status: 'ok', timestamp: new Date().toISOString() });
});

await fastify.register(cors, { origin: true });
await fastify.register(rateLimit, { max: 100, timeWindow: '1 minute' });

fastify.decorate('prisma', prisma);
fastify.decorate('redis', redis);
fastify.decorate('jwtSecret', JWT_SECRET);
fastify.decorate('connections', connections);
fastify.decorate('broadcastToSession', broadcastToSession);
fastify.decorate('sendWs', send);

await fastify.register(sessionRoutes, { prefix: '/v1/sessions' });
await fastify.register(deviceRoutes, { prefix: '/v1/devices' });
await fastify.register(groupRoutes, { prefix: '/v1/groups' });
await fastify.register(commandRoutes, { prefix: '/v1/commands' });

await fastify.listen({ port: parseInt(process.env.PORT) || 8080, host: '::' });
console.log(`Server running on port ${RAILWAY_PORT}`);

if (REDIS_URL && redis.connect) {
  (async () => {
    try {
      await redis.connect();
      console.log('Redis: connected');
    } catch (e) {
      console.error('Redis: connection failed, using fallback');
    }
  })();
}

(async () => {
  try {
    await prisma.$connect();
    console.log('Database: connected');
  } catch (e) {
    console.error('Database: connection failed:', e.message);
  }
})();

const wss = new WebSocketServer({ noServer: true });
const sessionMgr = sessionManager(prisma, redis);

fastify.server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  const match = url.pathname.match(/^\/sessions\/([^/]+)\/events$/);

  if (match) {
    const sessionId = match[1];
    const token = url.searchParams.get('token');

    wss.handleUpgrade(request, socket, head, (ws) => {
      websocketHandler(ws, request, {
        sessionId,
        token,
        prisma,
        redis,
        sessionManager: sessionMgr,
        connections
      });
    });
  } else {
    socket.destroy();
  }
});

setInterval(() => {
  console.log('Heartbeat...');
}, 60000);

async function gracefulShutdown() {
  console.log('Shutting down...');
  connections.forEach((conn) => {
    try {
      send(conn.ws, { type: 'SERVER_SHUTDOWN' });
      conn.ws.close();
    } catch { }
  });
  try { await prisma.$disconnect(); } catch { }
  try { if (redis.quit) await redis.quit(); } catch { }
  await fastify.close();
  process.exit(0);
}

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);
