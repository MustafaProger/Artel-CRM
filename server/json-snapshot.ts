import { createHash } from 'node:crypto';
import { performanceSpan } from './performance-trace';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
const hash = (raw: string) => createHash('sha256').update(raw).digest('hex');
const assign = (target: Record<string, unknown>, key: string, value: unknown) => {
  if (key === '__proto__') Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
  else target[key] = value;
};
/** Values loaded from JSON contain only ordinary records/arrays and primitives.
 * Every mutable node is copied; large immutable strings can safely be reused. */
function copy(value: Json): Json {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(copy);
  const result: { [key: string]: Json } = {};
  for (const key of Object.keys(value)) assign(result, key, copy(value[key]));
  return result;
}
/** Canonicalize callback output exactly as JSON.stringify/parse would. Fall back
 * for exotic objects and toJSON; cycles and BigInt still fail closed. */
function canonical(value: unknown, ancestors = new Set<object>(), property = ''): Json | undefined {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? (value === 0 ? 0 : value) : null;
  if (typeof value === 'undefined' || typeof value === 'function' || typeof value === 'symbol') return undefined;
  if (typeof value === 'bigint') throw new TypeError('Cannot serialize BigInt');
  const item = value as object;
  if (ancestors.has(item)) throw new TypeError('Cannot serialize circular data');
  if ((!Array.isArray(item) && ![Object.prototype, null].includes(Object.getPrototypeOf(item))) || 'toJSON' in item) {
    const wrapper: Record<string, unknown> = {}; assign(wrapper, property, item);
    return JSON.parse(JSON.stringify(wrapper))[property] as Json | undefined;
  }
  ancestors.add(item);
  try {
    if (Array.isArray(item)) return Array.from({ length: item.length }, (_, index) => canonical(item[index], ancestors, String(index)) ?? null);
    const result: { [key: string]: Json } = {};
    for (const key of Object.keys(item)) {
      const next = canonical((item as Record<string, unknown>)[key], ancestors, key);
      if (next !== undefined) assign(result, key, next);
    }
    return result;
  } finally { ancestors.delete(item); }
}
function same(left: Json, right: Json): boolean {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object' || Array.isArray(left) !== Array.isArray(right)) return false;
  const keys = Object.keys(left), other = Object.keys(right);
  if (keys.length !== other.length) return false;
  return keys.every((key, index) => key === other[index] && same((left as Record<string, Json>)[key], (right as Record<string, Json>)[key]));
}
/** Compare canonical JSON without allocating a second full graph. */
function matches(value: unknown, prior: Json, property = ''): boolean {
  if (value === prior) return true;
  if (typeof value === 'number') return (Number.isFinite(value) ? value : null) === prior;
  if (value === null || typeof value !== 'object') return false;
  if ((!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) || 'toJSON' in value) {
    const normalized = canonical(value, new Set(), property);
    return normalized !== undefined && same(normalized, prior);
  }
  if (prior === null || typeof prior !== 'object') return false;
  if (Array.isArray(value)) {
    if (!Array.isArray(prior) || value.length !== prior.length) return false;
    for (let i = 0; i < value.length; i++) {
      let item: unknown = value[i];
      if (item !== null && typeof item === 'object' && 'toJSON' in item) item = canonical(item, new Set(), String(i));
      if (!matches(item === undefined || typeof item === 'function' || typeof item === 'symbol' ? null : item, prior[i], String(i))) return false;
    }
    return true;
  }
  if (Array.isArray(prior)) return false;
  const keys = Object.keys(prior); let index = 0;
  for (const key of Object.keys(value)) {
    let item: unknown = (value as Record<string, unknown>)[key];
    if (item !== null && typeof item === 'object' && 'toJSON' in item) item = canonical(item, new Set(), key);
    if (item === undefined || typeof item === 'function' || typeof item === 'symbol') continue;
    if (key !== keys[index++] || !matches(item, prior[key], key)) return false;
  }
  return index === keys.length;
}
/** Private immutable JSON snapshot and top-level encoded fragments. Neither the
 * stored graph nor fragments are exposed to read callers or mutation callbacks. */
const verifiedSnapshot = Symbol('verified-json-snapshot');
export class JsonSnapshot {
  readonly raw: string;
  readonly #value: Json;
  readonly #fragments = new Map<string, string>();
  constructor(input: unknown, previous?: JsonSnapshot, verified?: { token: typeof verifiedSnapshot; raw: string }) {
    if (verified?.token === verifiedSnapshot) {
      this.#value = input as Json; this.raw = verified.raw; return;
    }
    const value = performanceSpan('codec.canonical-copy', () => canonical(input));
    if (value === undefined) throw new TypeError('Missing JSON data');
    this.#value = value;
    let data: string;
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const prior = previous ? previous.#value : undefined;
      const fields: string[] = [];
      for (const key of Object.keys(value)) {
        const fragment = prior !== null && typeof prior === 'object' && !Array.isArray(prior) && Object.hasOwn(prior, key) && same(value[key], prior[key])
          ? previous!.fragment(key) : JSON.stringify(value[key]);
        this.#fragments.set(key, fragment);
        fields.push(`${JSON.stringify(key)}:${fragment}`);
      }
      data = `{${fields.join(',')}}`;
    } else data = JSON.stringify(value);
    this.raw = performanceSpan('codec.checksum-envelope', () => `{"sha256":"${hash(data)}","data":${data}}`);
  }
  /** Takes ownership of a freshly parsed, checksum-verified private graph.
   * canonicalRaw must come from the SAME verification pass. No caller graph may
   * be supplied here; read callers receive clone(), never this owned value. */
  static fromVerified(value: unknown, canonicalRaw: string): JsonSnapshot {
    return new JsonSnapshot(value, undefined, { token: verifiedSnapshot, raw: canonicalRaw });
  }
  private fragment(key: string): string {
    const cached = this.#fragments.get(key);
    if (cached !== undefined) return cached;
    const raw = JSON.stringify((this.#value as Record<string, Json>)[key]);
    this.#fragments.set(key, raw); return raw;
  }
  clone(): unknown { return copy(this.#value); }
  matches(input: unknown): boolean {
    return matches(input, this.#value);
  }
}
