/**
 * 鉴权判定的进程内短缓存。省掉的是「每个请求都为了看一眼 pro 而跑一趟数据库」：
 * 实测东京一趟 180ms，还占着池子里一个连接（池只有 3 个）。
 *
 * Serverless 下每个热实例各有一份，冷实例照旧查库 —— 只会少查，不会多查。
 * 代价是判定最长可能比数据库旧一个 TTL，写 pro 的地方要主动 evict。
 */
export interface AuthSnapshot {
  id: number;
  email: string;
  name: string;
  pro: boolean;
}

interface Entry {
  value: AuthSnapshot;
  expiresAt: number;
}

/** 条目靠 TTL 自然过期；顺手加个上限，别让长命实例按用户数线性攒内存 */
const MAX_ENTRIES = 5000;

export class AuthTtlCache {
  private map: Map<string, Entry>;
  private ttlMs: number;
  private now: () => number;

  constructor(ttlMs: number, now: () => number = Date.now) {
    this.ttlMs = ttlMs;
    this.now = now;
    this.map = new Map();
  }

  get(key: string): AuthSnapshot | undefined {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (hit.expiresAt <= this.now()) {
      this.map.delete(key);
      return undefined;
    }
    return hit.value;
  }

  set(key: string, value: AuthSnapshot): void {
    this.map.set(key, { value, expiresAt: this.now() + this.ttlMs });
    if (this.map.size > MAX_ENTRIES) this.prune();
  }

  delete(key: string): void {
    this.map.delete(key);
  }

  get size(): number {
    return this.map.size;
  }

  private prune(): void {
    const deadline = this.now();
    for (const [k, entry] of this.map) {
      if (entry.expiresAt <= deadline) this.map.delete(k);
    }
  }
}
