import { jwtVerify } from 'jose';
import crypto from 'crypto';

const RECONNECT_WINDOWS = {
  MASTER_LOST: 30000,
  SLAVE_DISCONNECT: 15000
};

export async function websocketHandler(ws, request, { sessionId, token, prisma, redis, sessionManager, connections }) {
  const clientId = crypto.randomUUID();
  let deviceId = null;
  let isMaster = false;
  let isAuthenticated = false;
  
  const connectionInfo = {
    ws,
    sessionId,
    deviceId: null,
    isMaster: false,
    connectedAt: Date.now(),
    lastHeartbeat: Date.now(),
    reconnectCount: 0
  };
  
  connections.set(clientId, connectionInfo);
  
  try {
    if (token) {
      try {
        const secret = new TextEncoder().encode(process.env.JWT_SECRET || 'syncmaster-secret-key-change-in-production');
        const { payload } = await jwtVerify(token, secret);
        
        if (payload.session_id !== sessionId) {
          ws.close(4003, 'Session mismatch');
          connections.delete(clientId);
          return;
        }
        
        deviceId = payload.device_id;
        isMaster = payload.role === 'MASTER';
        isAuthenticated = true;
        
        connectionInfo.deviceId = deviceId;
        connectionInfo.isMaster = isMaster;
        
        await redis.hset(`session:${sessionId}:sockets`, deviceId, clientId);
        await redis.setex(`session:${sessionId}:socket:${deviceId}`, 3600, '1');
        
        if (isMaster) {
          await redis.setex(`session:${sessionId}:master`, 604800, deviceId);
        }
        
        if (!isMaster) {
          await prisma.device.update({
            where: { id: deviceId },
            data: { status: 'CONNECTED', lastSeenAt: new Date() }
          });
          
          const device = await prisma.device.findUnique({
            where: { id: deviceId },
            include: { group: true }
          });
          
          broadcastToSession(sessionId, connections, {
            type: 'SLAVE_JOINED',
            device: {
              device_id: device.id,
              name: device.name,
              status: device.status,
              group_id: device.groupId,
              group_name: device.group?.name,
              android_version: device.androidVersion,
              model: device.model
            }
          }, clientId);
        }
        
      } catch (e) {
        ws.close(4001, 'Invalid or expired token');
        connections.delete(clientId);
        return;
      }
    }
    
    ws.on('message', async (data) => {
      try {
        const message = JSON.parse(data.toString());
        connectionInfo.lastHeartbeat = Date.now();
        await handleMessage(message, clientId, { sessionId, deviceId, isMaster, isAuthenticated, prisma, redis, sessionManager, connections });
      } catch (e) {
        console.error('Failed to handle message:', e);
        send(ws, { type: 'ERROR', message: 'Invalid message format' });
      }
    });
    
    ws.on('pong', () => {
      connectionInfo.lastHeartbeat = Date.now();
    });
    
    ws.on('close', async (code, reason) => {
      connections.delete(clientId);
      
      if (deviceId) {
        await redis.del(`session:${sessionId}:socket:${deviceId}`);
        await redis.hdel(`session:${sessionId}:sockets`, deviceId);
        
        if (isMaster) {
          await redis.del(`session:${sessionId}:master`);
          
          broadcastToSession(sessionId, connections, {
            type: 'MASTER_LOST',
            device_id: deviceId,
            reconnect_timeout_ms: RECONNECT_WINDOWS.MASTER_LOST
          });
          
          setTimeout(async () => {
            const currentMaster = await redis.get(`session:${sessionId}:master`);
            if (!currentMaster) {
              await prisma.session.update({
                where: { id: sessionId },
                data: { masterId: null }
              });
            }
          }, RECONNECT_WINDOWS.MASTER_LOST);
        } else {
          await prisma.device.update({
            where: { id: deviceId },
            data: { status: 'DISCONNECTED' }
          });
          
          broadcastToSession(sessionId, connections, {
            type: 'SLAVE_DISCONNECTED',
            device_id: deviceId,
            reason: getDisconnectReason(code),
            was_clean: code === 1000
          });
        }
      }
    });
    
    ws.on('error', (error) => {
      console.error(`WebSocket error for client ${clientId}:`, error.message);
    });
    
    send(ws, {
      type: 'CONNECTED',
      client_id: clientId,
      session_id: sessionId,
      is_master: isMaster,
      server_time: Date.now()
    });
    
    if (isMaster) {
      const devices = await prisma.device.findMany({
        where: { sessionId },
        include: { group: true }
      });
      
      send(ws, {
        type: 'SESSION_STATE',
        devices: devices.map(d => ({
          device_id: d.id,
          name: d.name,
          role: d.role,
          status: d.status,
          group_id: d.groupId,
          group_name: d.group?.name,
          android_version: d.androidVersion,
          model: d.model,
          last_seen_at: d.lastSeenAt?.toISOString()
        }))
      });
      
      const ringBuffer = await sessionManager.getRingBuffer(sessionId);
      if (ringBuffer.length > 0) {
        send(ws, {
          type: 'RING_BUFFER',
          commands: ringBuffer
        });
      }
    }
    
  } catch (error) {
    console.error('WebSocket connection error:', error);
    ws.close(4000, 'Internal server error');
    connections.delete(clientId);
  }
}

function getDisconnectReason(code) {
  switch (code) {
    case 1000: return 'CLEAN_CLOSE';
    case 1001: return 'SERVER_SHUTDOWN';
    case 1002: return 'PROTOCOL_ERROR';
    case 1003: return 'UNSUPPORTED_DATA';
    case 1005: return 'NO_STATUS';
    case 1006: return 'ABNORMAL_CLOSE';
    case 1007: return 'INVALID_PAYLOAD';
    case 1008: return 'POLICY_VIOLATION';
    case 1009: return 'MESSAGE_TOO_BIG';
    case 1010: return 'MANDATORY_EXT';
    case 1011: return 'SERVER_ERROR';
    case 4000: return 'INTERNAL_ERROR';
    case 4001: return 'INVALID_TOKEN';
    case 4003: return 'UNAUTHORIZED';
    case 4004: return 'SESSION_NOT_FOUND';
    case 4010: return 'SESSION_ENDED';
    default: return 'UNKNOWN';
  }
}

async function handleMessage(message, clientId, { sessionId, deviceId, isMaster, isAuthenticated, prisma, redis, sessionManager, connections }) {
  const connection = connections.get(clientId);
  if (!connection) return;
  
  const { ws } = connection;
  
  switch (message.type) {
    case 'COMMAND':
      if (!isAuthenticated || !isMaster) {
        send(ws, { type: 'ERROR', message: 'Unauthorized', code: 4003 });
        return;
      }
      
      const command = message.command;
      if (!command || !command.action) {
        send(ws, { type: 'ERROR', message: 'Invalid command' });
        return;
      }
      
      const cmdId = command.id || crypto.randomUUID();
      const timestamp = command.ts || Date.now();
      const ttl = command.ttl || 5000;
      
      await prisma.commandLog.create({
        data: {
          id: cmdId,
          sessionId,
          action: command.action,
          payload: command.payload || {},
          target: command.target || 'ALL',
          ttlMs: ttl
        }
      });
      
      await sessionManager.addToRingBuffer(sessionId, {
        id: cmdId,
        action: command.action,
        payload: command.payload,
        target: command.target,
        ttl,
        ts: timestamp
      });
      
      const sentCount = await broadcastCommandToSlaves(sessionId, connections, { 
        type: 'COMMAND', 
        command: {
          id: cmdId,
          action: command.action,
          payload: command.payload,
          target: command.target,
          ttl,
          ts: timestamp
        }
      }, deviceId, prisma, redis);
      
      send(ws, {
        type: 'COMMAND_SENT',
        command_id: cmdId,
        target_count: sentCount,
        timestamp
      });
      break;
      
    case 'ACK':
      if (!isAuthenticated || isMaster) {
        send(ws, { type: 'ERROR', message: 'Only slaves can send ACKs' });
        return;
      }
      
      const { command_id, status, reason, latency_ms } = message;
      
      if (!command_id || !status) {
        send(ws, { type: 'ERROR', message: 'Invalid ACK format' });
        return;
      }
      
      const existingAck = await prisma.commandAck.findUnique({
        where: { commandId_deviceId: { commandId: command_id, deviceId } }
      });
      
      if (existingAck) {
        send(ws, { type: 'ERROR', message: 'ACK already sent for this command' });
        return;
      }
      
      await prisma.commandAck.create({
        data: {
          commandId: command_id,
          deviceId,
          status,
          reason,
          latencyMs: latency_ms,
          executedAt: new Date()
        }
      });
      
      const acks = await prisma.commandAck.findMany({
        where: { commandId: command_id }
      });
      
      const commandLog = await prisma.commandLog.findUnique({
        where: { id: command_id }
      });
      
      const totalExpected = commandLog?.target === 'ALL' 
        ? await prisma.device.count({ where: { sessionId, role: 'SLAVE' } })
        : 1;
      
      send(ws, { type: 'ACK_RECEIVED', command_id, status });
      
      if (acks.length >= totalExpected) {
        broadcastToMaster(sessionId, connections, {
          type: 'COMMAND_COMPLETE',
          command_id,
          all_acks: acks.map(a => ({
            device_id: a.deviceId,
            status: a.status,
            latency_ms: a.latencyMs
          }))
        });
      } else {
        broadcastToMaster(sessionId, connections, {
          type: 'COMMAND_ACK_BATCH',
          command_id,
          results: acks.map(a => ({
            device_id: a.deviceId,
            status: a.status,
            reason: a.reason,
            latency_ms: a.latencyMs
          }))
        });
      }
      break;
      
    case 'HEARTBEAT':
      connection.lastHeartbeat = Date.now();
      
      if (deviceId && !isMaster) {
        await prisma.device.update({
          where: { id: deviceId },
          data: { lastSeenAt: new Date() }
        });
        
        await redis.setex(`session:${sessionId}:socket:${deviceId}`, 3600, '1');
      }
      
      send(ws, { 
        type: 'PONG',
        server_time: Date.now(),
        latency_estimate: Date.now() - (message.client_time || Date.now())
      });
      break;
      
    case 'PING':
      send(ws, { type: 'PONG', server_time: Date.now() });
      break;
      
    case 'REQUEST_STATE':
      if (!isAuthenticated || !isMaster) return;
      
      const allDevices = await prisma.device.findMany({
        where: { sessionId },
        include: { group: true }
      });
      
      send(ws, {
        type: 'SESSION_STATE',
        devices: allDevices.map(d => ({
          device_id: d.id,
          name: d.name,
          role: d.role,
          status: d.status,
          group_id: d.groupId,
          group_name: d.group?.name
        }))
      });
      break;
      
    case 'BROADCAST':
      if (!isAuthenticated || !isMaster) return;
      
      broadcastToSession(sessionId, connections, {
        type: 'MESSAGE',
        from: deviceId,
        content: message.content,
        timestamp: Date.now()
      });
      break;
      
    default:
      console.log('Unknown message type:', message.type);
  }
}

export function send(ws, data) {
  if (ws && ws.readyState === 1) {
    try {
      ws.send(JSON.stringify(data));
      return true;
    } catch (e) {
      console.error('Failed to send message:', e);
      return false;
    }
  }
  return false;
}

export function broadcastToSession(sessionId, connections, message, excludeClientId = null) {
  let count = 0;
  connections.forEach((conn, clientId) => {
    if (conn.sessionId === sessionId && clientId !== excludeClientId) {
      if (send(conn.ws, message)) {
        count++;
      }
    }
  });
  return count;
}

function broadcastToMaster(sessionId, connections, message) {
  for (const conn of connections.values()) {
    if (conn.sessionId === sessionId && conn.isMaster) {
      send(conn.ws, message);
      return 1;
    }
  }
  return 0;
}

async function broadcastCommandToSlaves(sessionId, connections, message, excludeClientId, prisma, redis) {
  const slaves = await prisma.device.findMany({
    where: { sessionId, role: 'SLAVE', status: 'CONNECTED' }
  });
  
  let count = 0;
  const target = message.command?.target;
  
  for (const slave of slaves) {
    if (target !== 'ALL' && target !== `DEVICE:${slave.id}`) {
      if (target?.startsWith('GROUP:')) {
        const groupId = target.replace('GROUP:', '');
        if (slave.groupId !== groupId) continue;
      } else if (target !== `DEVICE:${slave.id}`) {
        continue;
      }
    }
    
    const socketId = await redis.hget(`session:${sessionId}:sockets`, slave.id);
    if (socketId) {
      const conn = connections.get(socketId);
      if (conn) {
        if (send(conn.ws, message)) {
          count++;
        }
      }
    }
  }
  
  return count;
}

export function getConnectionStats(connections) {
  const stats = {
    total: 0,
    masters: 0,
    slaves: 0,
    bySession: {}
  };
  
  connections.forEach((conn) => {
    stats.total++;
    if (conn.isMaster) stats.masters++;
    else stats.slaves++;
    
    if (!stats.bySession[conn.sessionId]) {
      stats.bySession[conn.sessionId] = { total: 0, masters: 0, slaves: 0 };
    }
    stats.bySession[conn.sessionId].total++;
    if (conn.isMaster) stats.bySession[conn.sessionId].masters++;
    else stats.bySession[conn.sessionId].slaves++;
  });
  
  return stats;
}
