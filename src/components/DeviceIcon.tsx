import { Laptop, Smartphone, Tablet } from 'lucide-react';
import type { DeviceType } from '../types';
export function DeviceIcon({
  type,
  size = 22,
}: {
  type?: DeviceType;
  size?: number;
}) {
  const Icon =
    type === 'phone' ? Smartphone : type === 'tablet' ? Tablet : Laptop;
  return <Icon size={size} strokeWidth={1.8} aria-hidden="true" />;
}
