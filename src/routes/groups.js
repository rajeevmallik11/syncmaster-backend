export async function groupRoutes(fastify, options) {
  fastify.post('/', async (request, reply) => {
    try {
      const { session_id, name, device_ids } = request.body || {};
      const { prisma } = fastify;

      if (!name || typeof name !== 'string') {
        return reply.code(400).send({ error: 'INVALID_NAME', message: 'Group name is required' });
      }

      if (!session_id) {
        return reply.code(400).send({ error: 'INVALID_REQUEST', message: 'session_id is required' });
      }

      const session = await prisma.session.findUnique({
        where: { id: session_id }
      });

      if (!session) {
        return reply.code(404).send({ error: 'SESSION_NOT_FOUND', message: 'Session not found' });
      }

      if (session.status === 'ENDED') {
        return reply.code(410).send({ error: 'SESSION_ENDED', message: 'Session has ended' });
      }

      const group = await prisma.group.create({
        data: {
          sessionId: session_id,
          name
        }
      });

      if (device_ids && Array.isArray(device_ids)) {
        await prisma.device.updateMany({
          where: { id: { in: device_ids }, sessionId: session_id },
          data: { groupId: group.id }
        });
      }

      return reply.code(201).send({
        group_id: group.id,
        session_id: group.sessionId,
        name: group.name,
        created_at: group.createdAt.toISOString()
      });
    } catch (error) {
      fastify.log.error(error);
      return reply.code(500).send({ error: 'INTERNAL_ERROR', message: 'Failed to create group' });
    }
  });

  fastify.get('/:groupId', async (request, reply) => {
    try {
      const { groupId } = request.params;
      const { prisma } = fastify;

      const group = await prisma.group.findUnique({
        where: { id: groupId },
        include: {
          devices: {
            select: {
              id: true,
              name: true,
              role: true,
              status: true,
              androidVersion: true,
              model: true,
              joinedAt: true
            }
          }
        }
      });

      if (!group) {
        return reply.code(404).send({ error: 'GROUP_NOT_FOUND', message: 'Group not found' });
      }

      return reply.send({
        group_id: group.id,
        session_id: group.sessionId,
        name: group.name,
        device_count: group.devices.length,
        devices: group.devices.map(d => ({
          device_id: d.id,
          name: d.name,
          role: d.role,
          status: d.status,
          android_version: d.androidVersion,
          model: d.model,
          joined_at: d.joinedAt.toISOString()
        })),
        created_at: group.createdAt.toISOString()
      });
    } catch (error) {
      fastify.log.error(error);
      return reply.code(500).send({ error: 'INTERNAL_ERROR' });
    }
  });

  fastify.delete('/:groupId', async (request, reply) => {
    try {
      const { groupId } = request.params;
      const { prisma, broadcastToSession } = fastify;

      const group = await prisma.group.findUnique({
        where: { id: groupId }
      });

      if (!group) {
        return reply.code(404).send({ error: 'GROUP_NOT_FOUND', message: 'Group not found' });
      }

      await prisma.device.updateMany({
        where: { groupId },
        data: { groupId: null }
      });

      await prisma.group.delete({
        where: { id: groupId }
      });

      broadcastToSession(group.sessionId, {
        type: 'GROUP_DELETED',
        group_id: groupId
      });

      return reply.send({ status: 'DELETED', group_id: groupId });
    } catch (error) {
      fastify.log.error(error);
      return reply.code(500).send({ error: 'INTERNAL_ERROR' });
    }
  });
}
