/**
 * 不可信 JSON 的收敛工具：零依赖，浏览器与 Node 都能引。
 * slide-data 与 media-source 共用，避免同一套「取值 + 兜底 + 夹范围」写两遍。
 */

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

export function num(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export function str(value: unknown, fallback: string, max: number): string {
  if (typeof value !== 'string') return fallback;
  return value.length > max ? value.slice(0, max) : value;
}

export function color(value: unknown, fallback: string): string {
  return typeof value === 'string' && HEX_COLOR.test(value) ? value : fallback;
}
