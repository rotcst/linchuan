import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { Device, Message, FileRef } from './app.js';

export type StoredFile = {
  ref: FileRef;
  path: string;
  from: string;
  to: string;
  createdAt: number;
};
export type StoredSession = {
  hash: string;
  deviceId: string;
  expiresAt: number;
};
export type History = {
  messages: Message[];
  hasMore: boolean;
  before?: number;
};

const asString = (value: unknown): string => {
  if (typeof value !== 'string') throw new Error('数据库字段类型错误');
  return value;
};
const asNumber = (value: unknown): number => {
  if (typeof value !== 'number') throw new Error('数据库字段类型错误');
  return value;
};

export class Storage {
  readonly db: DatabaseSync;
  private readonly dataDir: string;
  constructor(dataDir: string) {
    this.dataDir = path.resolve(dataDir);
    fs.mkdirSync(this.dataDir, { recursive: true });
    this.db = new DatabaseSync(path.join(this.dataDir, 'linchuan.sqlite'));
    this.db.exec(
      'PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;',
    );
    this.db
      .exec(`CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL, online INTEGER NOT NULL DEFAULT 0, last_seen INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS files (id TEXT PRIMARY KEY, name TEXT NOT NULL, size INTEGER NOT NULL, mime TEXT NOT NULL, path TEXT NOT NULL, sender TEXT NOT NULL REFERENCES devices(id), recipient TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, client_id TEXT, sender TEXT NOT NULL REFERENCES devices(id), recipient TEXT NOT NULL, text TEXT, created_at INTEGER NOT NULL, kind TEXT NOT NULL, file_id TEXT REFERENCES files(id) ON DELETE SET NULL);
      CREATE TABLE IF NOT EXISTS message_hides (message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE, device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE, hidden_at INTEGER NOT NULL, PRIMARY KEY(message_id, device_id));
      CREATE TABLE IF NOT EXISTS join_guard (id INTEGER PRIMARY KEY CHECK(id=1), failures INTEGER NOT NULL DEFAULT 0);
      INSERT OR IGNORE INTO join_guard(id,failures) VALUES(1,0);
      CREATE INDEX IF NOT EXISTS messages_history ON messages(recipient, created_at, id);
      CREATE INDEX IF NOT EXISTS messages_client ON messages(sender, client_id);`);
  }
  close() {
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    this.db.close();
  }
  loadDevices(): Device[] {
    return (
      this.db
        .prepare(
          'SELECT id,name,type,online,last_seen FROM devices ORDER BY id',
        )
        .all() as unknown[]
    ).map((row) => {
      const r = row as Record<string, unknown>;
      return {
        id: asString(r.id),
        name: asString(r.name),
        type: asString(r.type) as Device['type'],
        online: false,
        lastSeen: asNumber(r.last_seen),
      };
    });
  }
  loadSessions(): StoredSession[] {
    return (
      this.db
        .prepare('SELECT hash,device_id,expires_at FROM sessions')
        .all() as unknown[]
    ).map((row) => {
      const r = row as Record<string, unknown>;
      return {
        hash: asString(r.hash),
        deviceId: asString(r.device_id),
        expiresAt: asNumber(r.expires_at),
      };
    });
  }
  loadFiles(): StoredFile[] {
    return (
      this.db
        .prepare(
          'SELECT id,name,size,mime,sender,recipient,created_at FROM files',
        )
        .all() as unknown[]
    ).map((row) => {
      const r = row as Record<string, unknown>;
      const id = asString(r.id);
      return {
        ref: {
          id,
          name: asString(r.name),
          size: asNumber(r.size),
          mime: asString(r.mime),
        },
        path: path.resolve(this.dataDir, 'uploads', id),
        from: asString(r.sender),
        to: asString(r.recipient),
        createdAt: asNumber(r.created_at),
      };
    });
  }
  loadRecentMessages(limit = 10000): Message[] {
    return this.rowsToMessages(
      this.db
        .prepare(
          'SELECT m.*, f.name file_name, f.size file_size, f.mime file_mime FROM messages m LEFT JOIN files f ON f.id=m.file_id ORDER BY m.created_at DESC,m.id DESC LIMIT ?',
        )
        .all(Math.max(1, Math.min(10000, limit))) as unknown[],
    ).reverse();
  }
  saveDevice(device: Device) {
    this.db
      .prepare(
        'INSERT INTO devices(id,name,type,online,last_seen) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,type=excluded.type,online=excluded.online,last_seen=excluded.last_seen',
      )
      .run(
        device.id,
        device.name,
        device.type,
        device.online ? 1 : 0,
        device.lastSeen,
      );
  }
  saveSession(hash: string, deviceId: string, expiresAt: number) {
    this.db
      .prepare(
        'INSERT INTO sessions(hash,device_id,expires_at) VALUES(?,?,?) ON CONFLICT(hash) DO UPDATE SET device_id=excluded.device_id,expires_at=excluded.expires_at',
      )
      .run(hash, deviceId, expiresAt);
  }
  deleteSession(hash: string) {
    this.db.prepare('DELETE FROM sessions WHERE hash=?').run(hash);
  }
  joinFailures(): number {
    const row = this.db
      .prepare('SELECT failures FROM join_guard WHERE id=1')
      .get() as Record<string, unknown>;
    return asNumber(row.failures);
  }
  incrementJoinFailures(): number {
    this.db
      .prepare('UPDATE join_guard SET failures=failures+1 WHERE id=1')
      .run();
    return this.joinFailures();
  }
  resetJoinFailures() {
    this.db.prepare('UPDATE join_guard SET failures=0 WHERE id=1').run();
  }
  deleteDevice(id: string) {
    const result = this.db
      .prepare(
        'DELETE FROM devices WHERE id=? AND NOT EXISTS(SELECT 1 FROM sessions WHERE device_id=?) AND NOT EXISTS(SELECT 1 FROM messages WHERE sender=? OR recipient=?) AND NOT EXISTS(SELECT 1 FROM files WHERE sender=? OR recipient=?)',
      )
      .run(id, id, id, id, id, id);
    return result.changes > 0;
  }
  saveMessage(message: Message, storedFile?: StoredFile) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (storedFile)
        this.db
          .prepare(
            'INSERT INTO files(id,name,size,mime,path,sender,recipient,created_at) VALUES(?,?,?,?,?,?,?,?)',
          )
          .run(
            storedFile.ref.id,
            storedFile.ref.name,
            storedFile.ref.size,
            storedFile.ref.mime,
            storedFile.path,
            storedFile.from,
            storedFile.to,
            storedFile.createdAt,
          );
      this.db
        .prepare(
          'INSERT INTO messages(id,client_id,sender,recipient,text,created_at,kind,file_id) VALUES(?,?,?,?,?,?,?,?)',
        )
        .run(
          message.id,
          message.clientId ?? null,
          message.from,
          message.to,
          message.text ?? null,
          message.createdAt,
          message.kind,
          message.file?.id ?? null,
        );
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  findByClientId(from: string, clientId: string): Message | undefined {
    const rows = this.db
      .prepare(
        'SELECT m.*, f.name file_name,f.size file_size,f.mime file_mime FROM messages m LEFT JOIN files f ON f.id=m.file_id WHERE m.sender=? AND m.client_id=? ORDER BY m.created_at DESC,m.id DESC LIMIT 1',
      )
      .all(from, clientId) as unknown[];
    return this.rowsToMessages(rows)[0];
  }
  isHidden(messageId: string, deviceId: string): boolean {
    const row = this.db
      .prepare(
        'SELECT 1 AS hidden FROM message_hides WHERE message_id=? AND device_id=? LIMIT 1',
      )
      .get(messageId, deviceId) as { hidden?: unknown } | undefined;
    return row?.hidden === 1;
  }
  history(
    deviceId: string,
    to: string,
    before?: number,
    limit = 200,
    beforeId?: string,
  ): History & { beforeId?: string } {
    const cap = Math.max(1, Math.min(200, limit));
    const query =
      to === 'all'
        ? "m.recipient='all'"
        : '(m.recipient=? AND m.sender=?) OR (m.recipient=? AND m.sender=?)';
    const params: Array<string | number> =
      to === 'all' ? [] : [to, deviceId, deviceId, to];
    params.push(deviceId);
    const beforeSql =
      before === undefined
        ? ''
        : beforeId
          ? ' AND (m.created_at < ? OR (m.created_at = ? AND m.id < ?))'
          : ' AND m.created_at < ?';
    if (before !== undefined) {
      params.push(before);
      if (beforeId) params.push(before, beforeId);
    }
    params.push(cap + 1);
    const rows = this.db
      .prepare(
        `SELECT m.*,f.name file_name,f.size file_size,f.mime file_mime FROM messages m LEFT JOIN files f ON f.id=m.file_id WHERE (${query}) AND NOT EXISTS (SELECT 1 FROM message_hides h WHERE h.message_id=m.id AND h.device_id=?)${beforeSql} ORDER BY m.created_at DESC,m.id DESC LIMIT ?`,
      )
      .all(...params) as unknown[];
    const mapped = this.rowsToMessages(rows);
    const hasMore = mapped.length > cap;
    const result = mapped.slice(0, cap).reverse();
    return {
      messages: result,
      hasMore,
      ...(result[0]
        ? { before: result[0].createdAt, beforeId: result[0].id }
        : {}),
    };
  }
  findById(id: string): Message | undefined {
    const rows = this.db
      .prepare(
        'SELECT m.*, f.name file_name,f.size file_size,f.mime file_mime FROM messages m LEFT JOIN files f ON f.id=m.file_id WHERE m.id=? LIMIT 1',
      )
      .all(id) as unknown[];
    return this.rowsToMessages(rows)[0];
  }
  deleteFile(id: string) {
    this.db.prepare('DELETE FROM files WHERE id=?').run(id);
  }
  deleteMessage(id: string, requestingDeviceId: string): boolean {
    const result = this.db
      .prepare(
        "INSERT OR IGNORE INTO message_hides(message_id,device_id,hidden_at) SELECT id,?,? FROM messages WHERE id=? AND (sender=? OR recipient=? OR recipient='all')",
      )
      .run(
        requestingDeviceId,
        Date.now(),
        id,
        requestingDeviceId,
        requestingDeviceId,
      );
    return result.changes > 0;
  }
  private rowsToMessages(rows: unknown[]): Message[] {
    return rows.map((row) => {
      const r = row as Record<string, unknown>;
      const message: Message = {
        id: asString(r.id),
        from: asString(r.sender),
        to: asString(r.recipient),
        createdAt: asNumber(r.created_at),
        kind: asString(r.kind) as Message['kind'],
      };
      if (typeof r.client_id === 'string') message.clientId = r.client_id;
      if (typeof r.text === 'string') message.text = r.text;
      if (typeof r.file_id === 'string')
        message.file = {
          id: r.file_id,
          name: asString(r.file_name),
          size: asNumber(r.file_size),
          mime: asString(r.file_mime),
        };
      return message;
    });
  }
}

export const sessionHash = (token: string) =>
  crypto.createHash('sha256').update(token).digest('hex');
