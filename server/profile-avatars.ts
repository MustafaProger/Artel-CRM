import { randomUUID } from 'node:crypto';
import { decode, encode } from 'jpeg-js';
import { avatarPresetUrl, isAvatarPresetId, type AvatarPresetId } from '../web/src/avatar-model';
import { ApiError } from './api-error';

export type StoredAvatar = { preset: AvatarPresetId } | { version: string; image: string };
export const avatarUploadLimit = 64 * 1024;
const avatarStoredLimit = 32 * 1024;
const avatarEdge = 256;
const jpegPrefix = 'data:image/jpeg;base64,';
const base64Limit = (bytes: number) => Math.ceil(bytes / 3) * 4;
const jpegError = () => new ApiError(400, 'Фото должно быть в формате JPG, до 256 × 256 пикселей и 64 КБ.');

export function parseProfileAvatar(value: unknown): StoredAvatar | null {
  if (value === null) return null;
  if (isAvatarPresetId(value)) return { preset: value };
  if (typeof value !== 'string' || !value.startsWith(jpegPrefix) || value.length > jpegPrefix.length + base64Limit(avatarUploadLimit)) throw jpegError();
  const base64 = value.slice(jpegPrefix.length);
  const bytes = Buffer.from(base64, 'base64');
  if (bytes.length < 4 || bytes.length > avatarUploadLimit || bytes.toString('base64') !== base64
    || bytes.readUInt16BE(0) !== 0xffd8 || bytes.readUInt16BE(bytes.length - 2) !== 0xffd9) throw jpegError();

  try {
    const { width, height, data } = decode(bytes, {
      maxResolutionInMP: avatarEdge * avatarEdge / 1_000_000,
      maxMemoryUsageInMB: 6, tolerantDecoding: false,
    });
    if (width < 1 || height < 1 || width > avatarEdge || height > avatarEdge || data.length !== width * height * 4) throw jpegError();
    // Re-encode pixels only. Do not retain input comments, location metadata or other segments.
    for (const quality of [78, 62, 46, 30]) {
      const image = encode({ width, height, data }, quality).data;
      if (image.length <= avatarStoredLimit) return { version: randomUUID(), image: image.toString('base64') };
    }
  } catch {
    throw jpegError();
  }
  throw jpegError();
}

export function validStoredAvatar(value: unknown): value is StoredAvatar {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  if (Object.hasOwn(row, 'preset')) return Object.keys(row).length === 1 && isAvatarPresetId(row.preset);
  // Uploaded images are normalized before persistence. Check bounded encoding on load
  // without decoding every image while authenticating unrelated API requests.
  if (Object.keys(row).length !== 2 || typeof row.version !== 'string' || !/^[a-f0-9-]{36}$/.test(row.version)
    || typeof row.image !== 'string' || row.image.length > base64Limit(avatarStoredLimit) || row.image.length % 4 !== 0) return false;
  return /^\/9j\/[A-Za-z0-9+/]*={0,2}$/.test(row.image);
}

export function sameAvatar(saved: StoredAvatar | undefined, next: StoredAvatar | null) {
  if (!saved || !next) return !saved && !next;
  return 'preset' in saved ? 'preset' in next && saved.preset === next.preset
    : 'image' in next && saved.image === next.image;
}

export function profileAvatarProjection(id: string, avatar: StoredAvatar | undefined) {
  if (!avatar) return {};
  return 'preset' in avatar
    ? { avatarPreset: avatar.preset, avatarUrl: avatarPresetUrl(avatar.preset) }
    : { avatarUrl: `/api/auth/avatars/${encodeURIComponent(id)}?v=${avatar.version}` };
}
