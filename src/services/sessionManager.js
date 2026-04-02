const RING_BUFFER_SIZE = 100;
const SESSION_TTL = 86400;

export function sessionManager(prisma, redis) {
  return {
    async createSession() {
      const { randomBytes } = await import('crypto');
      const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
      let pairingCode = '';
      for (let i = 0; i < 8; i++) {
        pairingCode += chars[randomBytes(1)[0] % chars.length];
      }
      
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
      
      const session = await prisma.session.create({
        data: {
          pairingCode,
          status: 'PENDING',
          expiresAt
        }
      });
      
      await redis.setex(`pairing:${pairingCode}`, 600, session.id);
      
      return session;
    },
    
    async getSession(sessionId) {
      return prisma.session.findUnique({
        where: { id: sessionId }
      });
    },
    
    async updateSessionStatus(sessionId, status) {
      return prisma.session.update({
        where: { id: sessionId },
        data: {
          status,
          ...(status === 'ACTIVE' ? { activatedAt: new Date() } : {}),
          ...(status === 'ENDED' ? { endedAt: new Date() } : {})
        }
      });
    },
    
    async validatePairingCode(code) {
      const sessionId = await redis.get(`pairing:${code}`);
      if (!sessionId) return null;
      
      const session = await prisma.session.findUnique({
        where: { id: sessionId }
      });
      
      if (!session || session.status === 'ENDED') return null;
      if (session.expiresAt && new Date() > session.expiresAt) return null;
      
      return session;
    },
    
    async addDevice(sessionId, deviceData) {
      const device = await prisma.device.create({
        data: {
          sessionId,
          ...deviceData
        }
      });
      
      await redis.hset(`session:${sessionId}:sockets`, device.id, '');
      await redis.expire(`session:${sessionId}:sockets`, SESSION_TTL);
      
      const session = await prisma.session.findUnique({
        where: { id: sessionId }
      });
      
      if (session?.status === 'PENDING') {
        await this.updateSessionStatus(sessionId, 'ACTIVE');
      }
      
      return device;
    },
    
    async removeDevice(deviceId) {
      const device = await prisma.device.findUnique({
        where: { id: deviceId }
      });
      
      if (device) {
        await redis.hdel(`session:${device.sessionId}:sockets`, deviceId);
      }
      
      return prisma.device.delete({
        where: { id: deviceId }
      });
    },
    
    async getDevices(sessionId) {
      return prisma.device.findMany({
        where: { sessionId },
        orderBy: { joinedAt: 'asc' }
      });
    },
    
    async updateDeviceStatus(deviceId, status) {
      return prisma.device.update({
        where: { id: deviceId },
        data: { status, lastSeenAt: new Date() }
      });
    },
    
    async createGroup(sessionId, name) {
      return prisma.group.create({
        data: { sessionId, name }
      });
    },
    
    async assignDeviceToGroup(deviceId, groupId) {
      return prisma.device.update({
        where: { id: deviceId },
        data: { groupId }
      });
    },
    
    async addToRingBuffer(sessionId, command) {
      const key = `session:${sessionId}:ringbuffer`;
      await redis.lpush(key, JSON.stringify(command));
      await redis.ltrim(key, 0, RING_BUFFER_SIZE - 1);
      await redis.expire(key, SESSION_TTL);
    },
    
    async getRingBuffer(sessionId) {
      const key = `session:${sessionId}:ringbuffer`;
      const items = await redis.lrange(key, 0, RING_BUFFER_SIZE - 1);
      return items.map(item => JSON.parse(item)).reverse();
    },
    
    async clearRingBuffer(sessionId) {
      const key = `session:${sessionId}:ringbuffer`;
      return redis.del(key);
    },
    
    async setSocketMapping(sessionId, deviceId, socketId) {
      await redis.hset(`session:${sessionId}:sockets`, deviceId, socketId);
      await redis.setex(`session:${sessionId}:socket:${deviceId}`, 3600, '1');
    },
    
    async removeSocketMapping(sessionId, deviceId) {
      await redis.hdel(`session:${sessionId}:sockets`, deviceId);
      await redis.del(`session:${sessionId}:socket:${deviceId}`);
    },
    
    async getSocketId(sessionId, deviceId) {
      return redis.hget(`session:${sessionId}:sockets`, deviceId);
    },
    
    async getSessionSocketCount(sessionId) {
      const keys = await redis.keys(`session:${sessionId}:socket:*`);
      return keys.length;
    },
    
    async endSession(sessionId) {
      await this.updateSessionStatus(sessionId, 'ENDED');
      
      await Promise.all([
        redis.del(`session:${sessionId}:sockets`),
        redis.del(`session:${sessionId}:state`),
        redis.del(`session:${sessionId}:ringbuffer`),
        redis.del(`session:${sessionId}:master`)
      ]);
      
      const pattern = `session:${sessionId}:socket:*`;
      const socketKeys = await redis.keys(pattern);
      
      for (const key of socketKeys) {
        await redis.del(key);
      }
    },
    
    async getSessionMetrics(sessionId) {
      const [
        session,
        deviceCount,
        connectedCount,
        commandCount,
        activeSockets
      ] = await Promise.all([
        prisma.session.findUnique({ where: { id: sessionId } }),
        prisma.device.count({ where: { sessionId } }),
        prisma.device.count({ where: { sessionId, status: 'CONNECTED' } }),
        prisma.commandLog.count({ where: { sessionId } }),
        redis.keys(`session:${sessionId}:socket:*`)
      ]);
      
      return {
        session,
        deviceCount,
        connectedCount,
        commandCount,
        activeWebsocketConnections: activeSockets.length
      };
    }
  };
}
