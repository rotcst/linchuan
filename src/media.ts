import type { Message } from './types';

export function mediaKind(
  file: NonNullable<Message['file']>,
): 'image' | 'video' | null {
  if (
    /^(image\/(png|jpeg|gif|webp|avif))$/i.test(file.mime) ||
    /\.(png|jpe?g|gif|webp|avif)$/i.test(file.name)
  )
    return 'image';
  if (
    /^(video\/(mp4|quicktime|webm))$/i.test(file.mime) ||
    /\.(mp4|mov|webm)$/i.test(file.name)
  )
    return 'video';
  return null;
}

export function isPhoneBrowser() {
  return (
    /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  );
}
