import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { PrismaClient } from '@prisma/client';
import Redis from 'ioredis';
import { WebSocketServer } from 'ws';
import { randomBytes } from 'crypto';
import { sessionRoutes } from './routes/sessions.js';
import { deviceRoutes } from './routes/devices.js';
import { groupRoutes } from './routes/groups.js';
import { commandRoutes } from './routes/commands.js';
import { websocketHandler, broadcastToSession, send } from './services/websocket.js';
import { sessionManager } from './services/sessionManager.js';

const PORT = process.env.PORT || 3000;
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const JWT_SECRET = process.env.JWT_SECRET || 'syncmaster-secret-key-change-in-production';

export const prisma = new PrismaClient();
export const redis = new Redis(REDIS_URL);

export const connections = new Map();

const fastify = Fastify({
  logger: {
    level: process.env.LOG_LEVEL || 'info',
    transport: process.env.NODE_ENV !== 'production' ? {
      target: 'pino-pretty',
      options: { colorize: true }
    } : undefined
  },
  trustProxy: true
});

await fastify.register(cors, {
  origin: true,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Forwarded-For']
});

await fastify.register(rateLimit, {
  max: 100,
  timeWindow: '1 minute',
  errorResponseBuilder: (request, context) => ({
    error: 'RATE_LIMIT_EXCEEDED',
    message: `Rate limit exceeded. Try again in ${Math.ceil(context.ttl / 1000)} seconds`,
    retryAfter: Math.ceil(context.ttl / 1000)
  })
});

fastify.decorate('prisma', prisma);
fastify.decorate('redis', redis);
fastify.decorate('jwtSecret', JWT_SECRET);
fastify.decorate('sessionManager', sessionManager(prisma, redis));
fastify.decorate('connections', connections);
fastify.decorate('broadcastToSession', broadcastToSession);
fastify.decorate('sendWs', send);

await fastify.register(sessionRoutes, { prefix: '/v1/sessions' });
await fastify.register(deviceRoutes, { prefix: '/v1/devices' });
await fastify.register(groupRoutes, { prefix: '/v1/groups' });
await fastify.register(commandRoutes, { prefix: '/v1/commands' });

fastify.get('/health', async (request, reply) => {
  const dbHealthy = await checkDatabaseHealth();
  const redisHealthy = await checkRedisHealth();
  
  return reply.send({
    status: dbHealthy && redisHealthy ? 'ok' : 'degraded',
    timestamp: new Date().toISOString(),
    services: {
      database: dbHealthy ? 'healthy' : 'unhealthy',
      redis: redisHealthy ? 'healthy' : 'unhealthy'
    },
    uptime: process.uptime()
  });
});

async function checkDatabaseHealth() {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

async function checkRedisHealth() {
  try {
    await redis.ping();
    return true;
  } catch {
    return false;
  }
}

fastify.get('/qr/:code', async (request, reply) => {
  const { code } = request.params;
  return reply.send({
    code,
    url: `syncmaster://join/${code}`,
    deepLink: `syncmaster://join/${code}`,
    fallback: `${request.headers.host || `localhost:${PORT}`}/qr/${code}`
  });
});

await fastify.ready();
const address = await fastify.listen({ port: PORT, host: '0.0.0.0' });

const wss = new WebSocketServer({ noServer: true });

const sessionMgr = sessionManager(prisma, redis);

fastify.server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  const pathname = url.pathname;
  const match = pathname.match(/^\/sessions\/([^/]+)\/events$/);
  if (match) {
    const sessionId = match[1];
    const token = url.searchParams.get('token');
    wss.handleUpgrade(request, socket, head, (ws) => {
      websocketHandler(ws, request, { 
        sessionId, token, prisma, redis, 
        sessionManager: sessionMgr, connections 
      });
    });
  } else {
    socket.destroy();
  }
});

console.log(`SyncMaster server running on port ${PORT}`);
console.log(`WebSocket endpoint: ws://0.0.0.0:${PORT}/sessions/{sessionId}/events`);

setInterval(async () => {
  try {
    const sessionIds = new Set();
    connections.forEach((conn) => {
      if (conn.sessionId) {
        sessionIds.add(conn.sessionId);
      }
    });
    
    for (const sessionId of sessionIds) {
      const socketKeys = await redis.keys(`session:${sessionId}:socket:*`);
      const activeSockets = new Set();
      
      for (const key of socketKeys) {
        const deviceId = key.split(':').pop();
        const clientId = await redis.hget(`session:${sessionId}:sockets`, deviceId);
        if (clientId && connections.has(clientId)) {
          activeSockets.add(deviceId);
        }
      }
      
      const devices = await prisma.device.findMany({
        where: { sessionId },
        select: { id: true }
      });
      
      for (const device of devices) {
        if (!activeSockets.has(device.id)) {
          await prisma.device.update({
            where: { id: device.id },
            data: { status: 'DISCONNECTED' }
          });
        }
      }
    }
  } catch (error) {
    fastify.log.error('Health check error:', error);
  }
}, 30000);

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

async function gracefulShutdown() {
  console.log('Shutting down gracefully...');
  
  connections.forEach((conn) => {
    try {
      send(conn.ws, { type: 'SERVER_SHUTDOWN' });
      conn.ws.close(1001, 'Server shutting down');
    } catch (e) {
      // Ignore
    }
  });
  
  connections.clear();
  
  await prisma.$disconnect();
  await redis.quit();
  await fastify.close();
  process.exit(0);
}

export default fastify;
