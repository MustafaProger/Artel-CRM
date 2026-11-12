export const avatarPresetIds = [
  'preset-01', 'preset-02', 'preset-03', 'preset-04', 'preset-05', 'preset-06',
  'preset-07', 'preset-08', 'preset-09', 'preset-10', 'preset-11', 'preset-12',
  'preset-13', 'preset-14', 'preset-15', 'preset-16', 'preset-17', 'preset-18',
  'preset-19', 'preset-20', 'preset-21', 'preset-22', 'preset-23', 'preset-24',
  'preset-25', 'preset-26', 'preset-27', 'preset-28', 'preset-29', 'preset-30',
] as const;

export type AvatarPresetId = typeof avatarPresetIds[number];
export const isAvatarPresetId = (value: unknown): value is AvatarPresetId => avatarPresetIds.some(id => id === value);
export const avatarPresetUrl = (id: AvatarPresetId) => `/avatars/${id}.webp`;
