export const GPU_MODEL_OPTIONS = [
  'RTX 3060',
  'RTX 3070',
  'RTX 3080',
  'RTX 4060',
  'RTX 4070',
  'RTX 4070 Ti',
  'RTX 4080',
  'RTX 4090',
] as const;

export type GpuModel = (typeof GPU_MODEL_OPTIONS)[number];
