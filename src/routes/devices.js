export async function deviceRoutes(fastify, options) {
  fastify.get('/:deviceId', async (request, reply) => {
    try {
      const { deviceId } = request.params;
      const { prisma } = fastify;

      const device = await prisma.device.findUnique({
        where: { id: deviceId }
      });

      if (!device) {
        return reply.code(404).send({ error: 'DEVICE_NOT_FOUND', message: 'Device not found' });
      }

      return reply.send({
        device_id: device.id,
        session_id: device.sessionId,
        role: device.role,
        name: device.name,
        status: device.status,
        group_id: device.groupId,
        android_version: device.androidVersion,
        model: device.model,
        joined_at: device.joinedAt.toISOString(),
        last_seen_at: device.lastSeenAt?.toISOString()
      });
    } catch (error) {
      fastify.log.error(error);
      return reply.code(500).send({ error: 'INTERNAL_ERROR', message: 'Failed to get device' });
    }
  });

  fastify.put('/:deviceId/group', async (request, reply) => {
    try {
      const { deviceId } = request.params;
      const { group_id } = request.body || {};
      const { prisma } = fastify;

      const device = await prisma.device.update({
        where: { id: deviceId },
        data: { groupId: group_id || null }
      });

      return reply.send({
        device_id: device.id,
        group_id: device.groupId
      });
    } catch (error) {
      fastify.log.error(error);
      if (error.code === 'P2025') {
        return reply.code(404).send({ error: 'DEVICE_NOT_FOUND', message: 'Device not found' });
      }
      return reply.code(500).send({ error: 'INTERNAL_ERROR', message: 'Failed to update device' });
    }
  });

  fastify.delete('/:deviceId', async (request, reply) => {
    try {
      const { deviceId } = request.params;
      const { prisma, redis } = fastify;

      const device = await prisma.device.findUnique({
        where: { id: deviceId }
      });

      if (!device) {
        return reply.code(404).send({ error: 'DEVICE_NOT_FOUND', message: 'Device not found' });
      }

      await prisma.device.delete({
        where: { id: deviceId }
      });

      if (device.sessionId) {
        await redis.hdel(`session:${device.sessionId}:sockets`, deviceId);
        
        const { broadcastToSession } = fastify;
        broadcastToSession(device.sessionId, {
          type: 'SLAVE_DISCONNECTED',
          device_id: deviceId,
          reason: 'REMOVED'
        });
      }

      return reply.send({ status: 'REMOVED', device_id: deviceId });
    } catch (error) {
      fastify.log.error(error);
      return reply.code(500).send({ error: 'INTERNAL_ERROR', message: 'Failed to remove device' });
    }
  });

  fastify.get('/:deviceId/status', async (request, reply) => {
    try {
      const { deviceId } = request.params;
      const { prisma, redis } = fastify;

      const device = await prisma.device.findUnique({
        where: { id: deviceId }
      });

      if (!device) {
        return reply.code(404).send({ error: 'DEVICE_NOT_FOUND', message: 'Device not found' });
      }

      let isOnline = false;
      if (device.sessionId) {
        const socketKey = `session:${device.sessionId}:socket:${deviceId}`;
        isOnline = await redis.exists(socketKey);
      }

      return reply.send({
        device_id: deviceId,
        status: isOnline ? 'CONNECTED' : device.status,
        last_seen_at: device.lastSeenAt?.toISOString()
      });
    } catch (error) {
      fastify.log.error(error);
      return reply.code(500).send({ error: 'INTERNAL_ERROR' });
    }
  });
}
