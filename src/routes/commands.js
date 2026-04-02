import crypto from 'crypto';

export async function commandRoutes(fastify, options) {
  fastify.post('/', async (request, reply) => {
    try {
      const { session_id, action, payload, target, ttl_ms } = request.body || {};
      const { prisma, sessionManager, broadcastToSession } = fastify;

      if (!session_id || !action) {
        return reply.code(400).send({ 
          error: 'INVALID_REQUEST', 
          message: 'session_id and action are required' 
        });
      }

      const session = await prisma.session.findUnique({
        where: { id: session_id }
      });

      if (!session) {
        return reply.code(404).send({ error: 'SESSION_NOT_FOUND', message: 'Session not found' });
      }

      if (session.status !== 'ACTIVE') {
        return reply.code(400).send({ error: 'SESSION_NOT_ACTIVE', message: 'Session is not active' });
      }

      const commandId = crypto.randomUUID();
      const ttl = ttl_ms || 5000;

      await prisma.commandLog.create({
        data: {
          id: commandId,
          sessionId: session_id,
          action,
          payload: payload || {},
          target: target || 'ALL',
          ttlMs: ttl
        }
      });

      await sessionManager.addToRingBuffer(session_id, {
        id: commandId,
        action,
        payload: payload || {},
        target: target || 'ALL',
        ttl,
        ts: Date.now()
      });

      broadcastToSession(session_id, {
        type: 'COMMAND',
        command: {
          id: commandId,
          action,
          payload: payload || {},
          target: target || 'ALL',
          ttl,
          ts: Date.now()
        }
      });

      return reply.code(201).send({
        command_id: commandId,
        session_id,
        action,
        target: target || 'ALL',
        ttl_ms: ttl,
        issued_at: new Date().toISOString()
      });
    } catch (error) {
      fastify.log.error(error);
      return reply.code(500).send({ error: 'INTERNAL_ERROR', message: 'Failed to send command' });
    }
  });

  fastify.get('/:sessionId', async (request, reply) => {
    try {
      const { sessionId } = request.params;
      const { limit = 50, offset = 0, action } = request.query;
      const { prisma } = fastify;

      const session = await prisma.session.findUnique({
        where: { id: sessionId }
      });

      if (!session) {
        return reply.code(404).send({ error: 'SESSION_NOT_FOUND', message: 'Session not found' });
      }

      const where = {
        sessionId,
        ...(action && { action })
      };

      const [commands, total] = await Promise.all([
        prisma.commandLog.findMany({
          where,
          include: {
            acks: {
              include: {
                device: {
                  select: { id: true, name: true }
                }
              }
            }
          },
          orderBy: { issuedAt: 'desc' },
          take: Math.min(parseInt(limit), 100),
          skip: parseInt(offset)
        }),
        prisma.commandLog.count({ where })
      ]);

      return reply.send({
        commands: commands.map(cmd => ({
          id: cmd.id,
          action: cmd.action,
          payload: cmd.payload,
          target: cmd.target,
          ttl_ms: cmd.ttlMs,
          issued_at: cmd.issuedAt.toISOString(),
          acks: cmd.acks.map(ack => ({
            device_id: ack.deviceId,
            device_name: ack.device?.name,
            status: ack.status,
            reason: ack.reason,
            latency_ms: ack.latencyMs,
            executed_at: ack.executedAt?.toISOString()
          })),
          ack_count: cmd.acks.length,
          success_count: cmd.acks.filter(a => a.status === 'ACK' || a.status === 'ACK_FALLBACK').length
        })),
        pagination: {
          total,
          limit: parseInt(limit),
          offset: parseInt(offset),
          has_more: parseInt(offset) + commands.length < total
        }
      });
    } catch (error) {
      fastify.log.error(error);
      return reply.code(500).send({ error: 'INTERNAL_ERROR' });
    }
  });

  fastify.get('/:sessionId/stats', async (request, reply) => {
    try {
      const { sessionId } = request.params;
      const { prisma, redis } = fastify;

      const session = await prisma.session.findUnique({
        where: { id: sessionId }
      });

      if (!session) {
        return reply.code(404).send({ error: 'SESSION_NOT_FOUND' });
      }

      const [deviceCount, commandCount, recentCommands, connectedDevices] = await Promise.all([
        prisma.device.count({ where: { sessionId } }),
        prisma.commandLog.count({ where: { sessionId } }),
        prisma.commandLog.findMany({
          where: { sessionId },
          orderBy: { issuedAt: 'desc' },
          take: 10,
          include: { acks: true }
        }),
        prisma.device.count({ where: { sessionId, status: 'CONNECTED' } })
      ]);

      const activeSockets = await redis.keys(`session:${sessionId}:socket:*`);

      const successRate = recentCommands.length > 0
        ? (recentCommands.reduce((acc, cmd) => {
            const acked = cmd.acks.filter(a => a.status === 'ACK' || a.status === 'ACK_FALLBACK').length;
            return acc + (acked / Math.max(cmd.acks.length, 1));
          }, 0) / recentCommands.length * 100).toFixed(1)
        : 0;

      return reply.send({
        session_id: sessionId,
        status: session.status,
        device_count: deviceCount,
        connected_devices: connectedDevices,
        active_websockets: activeSockets.length,
        total_commands: commandCount,
        created_at: session.createdAt.toISOString(),
        activated_at: session.activatedAt?.toISOString(),
        uptime_seconds: session.activatedAt
          ? Math.floor((Date.now() - new Date(session.activatedAt).getTime()) / 1000)
          : 0,
        recent_stats: {
          success_rate: parseFloat(successRate),
          commands_last_24h: await prisma.commandLog.count({
            where: {
              sessionId,
              issuedAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) }
            }
          })
        }
      });
    } catch (error) {
      fastify.log.error(error);
      return reply.code(500).send({ error: 'INTERNAL_ERROR' });
    }
  });
}
