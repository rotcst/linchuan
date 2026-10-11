export type DeviceType = 'computer' | 'phone' | 'tablet';
export interface Device {
  id: string;
  name: string;
  type: DeviceType;
  online: boolean;
  lastSeen?: string | number;
}
export interface Message {
  id: string;
  clientId: string;
  from: string;
  to: string;
  text: string;
  createdAt: string | number;
  kind: 'text' | 'file';
  file?: { id: string; name: string; size: number; mime: string };
}
export interface ServerInfo {
  serverName: string;
  urls: string[];
  expiresHours: number | null;
  persistent: boolean;
  maxFileBytes: number | null;
  publicUrl: string | null;
}
export interface Session {
  token: string;
  device: Device;
  devices: Device[];
}
export type Connection = 'connecting' | 'connected' | 'reconnecting';
export interface Upload {
  id: string;
  name: string;
  size: number;
  to: string;
  progress: number;
  state: 'queued' | 'uploading' | 'done' | 'error' | 'cancelled';
  error?: string;
}
