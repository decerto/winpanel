import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import type { SecretVault } from '../security/vault.js';
import type { DatabaseHandle } from '../db/index.js';
import { gameServerPorts, gameServers } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { readSecret } from '../security/secret-store.js';

const MAX_LOG_BYTES = 128 * 1024;

export interface ConsoleSnapshot {
  available: boolean;
  kind: 'rcon' | 'stdin' | 'none';
  lines: string[];
}

export async function readConsoleSnapshot(
  server: typeof gameServers.$inferSelect,
  kind: ConsoleSnapshot['kind'],
): Promise<ConsoleSnapshot> {
  const logPath = server.serviceId
    ? path.join(server.dataPath, 'logs', `${server.serviceId}.out.log`)
    : null;
  const text = logPath ? await readTail(logPath) : '';
  return { available: kind !== 'none' && server.serviceId !== null, kind, lines: text.split(/\r?\n/).filter(Boolean).slice(-500) };
}

async function readTail(filePath: string): Promise<string> {
  const handle = await fs.open(filePath, 'r').catch(() => null);
  if (!handle) return '';
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, MAX_LOG_BYTES);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, Math.max(0, size - length));
    return buffer.toString('utf8');
  } finally {
    await handle.close();
  }
}

function packet(id: number, type: number, body: string): Buffer {
  const payload = Buffer.from(body, 'utf8');
  const data = Buffer.alloc(4 + 4 + 4 + payload.length + 2);
  data.writeInt32LE(data.length - 4, 0);
  data.writeInt32LE(id, 4);
  data.writeInt32LE(type, 8);
  payload.copy(data, 12);
  return data;
}

function readPacket(socket: net.Socket): Promise<{ id: number; type: number; body: string }> {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length < 4) return;
      const length = buffer.readInt32LE(0);
      if (length < 10 || buffer.length < length + 4) return;
      socket.off('data', onData);
      resolve({
        id: buffer.readInt32LE(4),
        type: buffer.readInt32LE(8),
        body: buffer.subarray(12, length + 2).toString('utf8'),
      });
    };
    socket.on('data', onData);
    socket.once('error', reject);
    socket.once('close', () => reject(new Error('The game console closed the connection.')));
  });
}

export async function sendRconCommand(
  db: DatabaseHandle,
  vault: SecretVault,
  server: typeof gameServers.$inferSelect,
  command: string,
): Promise<string> {
  const binding = db.db
    .select({ port: gameServerPorts.port, purpose: gameServerPorts.purpose })
    .from(gameServerPorts)
    .where(eq(gameServerPorts.gameServerId, server.id))
    .all()
    .find((entry) => entry.purpose === 'rcon');
  const password = readSecret(db, vault, `game-server:${server.id}:rcon`);
  if (!binding || !password) throw new Error('The game console is not configured for this server.');

  const socket = net.createConnection({ host: '127.0.0.1', port: binding.port });
  socket.setTimeout(5000);
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
      socket.once('timeout', () => reject(new Error('The game console did not respond.')));
    });
    socket.write(packet(1, 3, password));
    const auth = await readPacket(socket);
    if (auth.id === -1) throw new Error('The game console rejected its password.');
    socket.write(packet(2, 2, command));
    return (await readPacket(socket)).body;
  } finally {
    socket.destroy();
  }
}
