import { randomBytes } from 'crypto';
import { SignJWT, jwtVerify } from 'jose';

async function generatePairingCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 8; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

export async function sessionRoutes(fastify, options) {
  fastify.post('/', async (request, reply) => {
    try {
      const { prisma } = fastify;
      
      const pairingCode = await generatePairingCode();
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
      
      const session = await prisma.session.create({
        data: {
          pairingCode,
          status: 'PENDING',
          expiresAt
        }
      });
      
      await fastify.redis.setex(`pairing:${pairingCode}`, 600, session.id);
      
      return reply.code(201).send({
        session_id: session.id,
        pairing_code: pairingCode,
        qr_url: `https://syncmaster-backend-production.up.railway.app/qr/${pairingCode}`,
        expires_at: expiresAt.toISOString()
      });
    } catch (error) {
      fastify.log.error(error);
      return reply.code(500).send({ error: 'INTERNAL_ERROR', message: 'Failed to create session' });
    }
  });
  
  fastify.post('/master/register', {
    config: {
      rateLimit: {
        max: 10,
        timeWindow: '60000'
      }
    }
  }, async (request, reply) => {
    try {
      const { session_id, device_name, android_version, model } = request.body || {};
      const { prisma, jwtSecret, redis } = fastify;
      
      if (!session_id) {
        return reply.code(400).send({ error: 'INVALID_REQUEST', message: 'session_id is required' });
      }
      
      const session = await prisma.session.findUnique({
        where: { id: session_id }
      });
      
      if (!session) {
        return reply.code(404).send({ error: 'SESSION_NOT_FOUND' });
      }
      
      if (session.status === 'ENDED') {
        return reply.code(410).send({ error: 'SESSION_ENDED' });
      }
      
      if (session.masterId) {
        return reply.code(409).send({ error: 'MASTER_ALREADY_EXISTS', message: 'Session already has a master device' });
      }
      
      const deviceId = crypto.randomUUID();
      const secret = new TextEncoder().encode(jwtSecret);
      
      const authToken = await new SignJWT({
        device_id: deviceId,
        session_id: session_id,
        role: 'MASTER'
      })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuedAt()
        .setExpirationTime('7d')
        .sign(secret);
      
      const device = await prisma.device.create({
        data: {
          id: deviceId,
          sessionId: session_id,
          role: 'MASTER',
          name: device_name || 'Master Device',
          androidVersion: android_version,
          model,
          status: 'CONNECTED',
          authToken
        }
      });
      
      await prisma.session.update({
        where: { id: session_id },
        data: { masterId: deviceId }
      });
      
      await redis.setex(`session:${session_id}:master`, 604800, deviceId);
      
      return reply.code(201).send({
        session_id: session_id,
        device_id: deviceId,
        auth_token: authToken,
        ws_url: `wss://syncmaster-backend-production.up.railway.app/sessions/${session_id}/events?token=${encodeURIComponent(authToken)}`,
        expires_in: 604800
      });
    } catch (error) {
      fastify.log.error(error);
      return reply.code(500).send({ error: 'INTERNAL_ERROR', message: 'Failed to register master' });
    }
  });
  
  fastify.post('/:code/join', {
    config: {
      rateLimit: {
        max: 5,
        timeWindow: '60000'
      }
    }
  }, async (request, reply) => {
    try {
      const { code } = request.params;
      const { device_name, android_version, model } = request.body || {};
      const { prisma, jwtSecret, redis } = fastify;
      
      const normalizedCode = code.toUpperCase().trim();
      const sessionId = await redis.get(`pairing:${normalizedCode}`);
      
      if (!sessionId) {
        return reply.code(404).send({ error: 'SESSION_NOT_FOUND', message: 'Invalid or expired pairing code' });
      }
      
      const session = await prisma.session.findUnique({
        where: { id: sessionId }
      });
      
      if (!session) {
        return reply.code(404).send({ error: 'SESSION_NOT_FOUND' });
      }
      
      if (session.status === 'ENDED') {
        return reply.code(410).send({ error: 'SESSION_ENDED', message: 'This session has ended' });
      }
      
      if (session.expiresAt && new Date() > session.expiresAt) {
        return reply.code(410).send({ error: 'CODE_EXPIRED', message: 'Pairing code has expired' });
      }
      
      const currentDevices = await prisma.device.count({
        where: { sessionId }
      });
      
      if (currentDevices >= session.maxSlaves) {
        return reply.code(409).send({
          error: 'ROOM_FULL',
          message: 'Session is full',
          max: session.maxSlaves,
          current: currentDevices
        });
      }
      
      const deviceId = crypto.randomUUID();
      const secret = new TextEncoder().encode(jwtSecret);
      
      const authToken = await new SignJWT({
        device_id: deviceId,
        session_id: sessionId,
        role: 'SLAVE'
      })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuedAt()
        .setExpirationTime('24h')
        .sign(secret);
      
      const device = await prisma.device.create({
        data: {
          id: deviceId,
          sessionId,
          role: 'SLAVE',
          name: device_name || 'Unknown Device',
          androidVersion: android_version,
          model,
          status: 'CONNECTED',
          authToken
        }
      });
      
      if (session.status === 'PENDING') {
        await prisma.session.update({
          where: { id: sessionId },
          data: { status: 'ACTIVE', activatedAt: new Date() }
        });
      }
      
      await redis.hset(`session:${sessionId}:sockets`, deviceId, '');
      await redis.expire(`session:${sessionId}:sockets`, 86400);
      
      const { broadcastToSession, connections } = fastify;
      broadcastToSession(sessionId, connections, {
        type: 'SLAVE_JOINED',
        device: {
          device_id: device.id,
          name: device.name,
          status: device.status,
          android_version: device.androidVersion,
          model: device.model
        }
      });
      
      return reply.send({
        session_id: sessionId,
        device_id: deviceId,
        auth_token: authToken,
        ws_url: `wss://syncmaster-backend-production.up.railway.app/sessions/${sessionId}/events?token=${encodeURIComponent(authToken)}`
      });
    } catch (error) {
      fastify.log.error(error);
      return reply.code(500).send({ error: 'INTERNAL_ERROR', message: 'Failed to join session' });
    }
  });
  
  fastify.get('/:sessionId/devices', async (request, reply) => {
    try {
      const { sessionId } = request.params;
      const { prisma } = fastify;
      
      const devices = await prisma.device.findMany({
        where: { sessionId },
        orderBy: { joinedAt: 'asc' }
      });
      
      return reply.send({
        devices: devices.map(d => ({
          device_id: d.id,
          name: d.name,
          role: d.role,
          status: d.status,
          group_id: d.groupId,
          android_version: d.androidVersion,
          model: d.model,
          last_seen_at: d.lastSeenAt?.toISOString(),
          joined_at: d.joinedAt.toISOString()
        }))
      });
    } catch (error) {
      fastify.log.error(error);
      return reply.code(500).send({ error: 'INTERNAL_ERROR' });
    }
  });
  
  fastify.delete('/:sessionId', async (request, reply) => {
    try {
      const { sessionId } = request.params;
      const { prisma, redis, broadcastToSession } = fastify;
      
      const session = await prisma.session.findUnique({
        where: { id: sessionId }
      });
      
      if (!session) {
        return reply.code(404).send({ error: 'SESSION_NOT_FOUND' });
      }
      
      await prisma.session.update({
        where: { id: sessionId },
        data: {
          status: 'ENDED',
          endedAt: new Date()
        }
      });
      
      await Promise.all([
        redis.del(`session:${sessionId}:sockets`),
        redis.del(`session:${sessionId}:state`),
        redis.del(`session:${sessionId}:ringbuffer`),
        redis.del(`session:${sessionId}:master`),
        redis.del(`pairing:${session.pairingCode}`)
      ]);
      
      broadcastToSession(sessionId, connections, { type: 'SESSION_ENDED', reason: 'MASTER_ENDED' });
      
      return reply.send({
        status: 'ENDED',
        session_id: sessionId,
        ended_at: new Date().toISOString()
      });
    } catch (error) {
      fastify.log.error(error);
      return reply.code(500).send({ error: 'INTERNAL_ERROR' });
    }
  });
  
  fastify.get('/:sessionId', async (request, reply) => {
    try {
      const { sessionId } = request.params;
      const { prisma } = fastify;
      
      const session = await prisma.session.findUnique({
        where: { id: sessionId },
        include: {
          devices: {
            select: {
              id: true,
              name: true,
              role: true,
              status: true,
              groupId: true,
              joinedAt: true
            }
          },
          _count: {
            select: { devices: true }
          }
        }
      });
      
      if (!session) {
        return reply.code(404).send({ error: 'SESSION_NOT_FOUND' });
      }
      
      return reply.send({
        session_id: session.id,
        status: session.status,
        pairing_code: session.pairingCode,
        master_id: session.masterId,
        device_count: session._count.devices,
        max_slaves: session.maxSlaves,
        created_at: session.createdAt.toISOString(),
        activated_at: session.activatedAt?.toISOString(),
        ended_at: session.endedAt?.toISOString(),
        expires_at: session.expiresAt?.toISOString(),
        devices: session.devices
      });
    } catch (error) {
      fastify.log.error(error);
      return reply.code(500).send({ error: 'INTERNAL_ERROR' });
    }
  });
  
  fastify.put('/:sessionId', async (request, reply) => {
    try {
      const { sessionId } = request.params;
      const { max_slaves, expires_in_minutes } = request.body || {};
      const { prisma } = fastify;
      
      const session = await prisma.session.findUnique({
        where: { id: sessionId }
      });
      
      if (!session) {
        return reply.code(404).send({ error: 'SESSION_NOT_FOUND' });
      }
      
      const updateData = {};
      
      if (typeof max_slaves === 'number' && max_slaves > 0) {
        updateData.maxSlaves = max_slaves;
      }
      
      if (typeof expires_in_minutes === 'number' && expires_in_minutes > 0) {
        updateData.expiresAt = new Date(Date.now() + expires_in_minutes * 60 * 1000);
      }
      
      const updated = await prisma.session.update({
        where: { id: sessionId },
        data: updateData
      });
      
      return reply.send({
        session_id: updated.id,
        max_slaves: updated.maxSlaves,
        expires_at: updated.expiresAt?.toISOString()
      });
    } catch (error) {
      fastify.log.error(error);
      return reply.code(500).send({ error: 'INTERNAL_ERROR' });
    }
  });
}
