/**
 * 覆盖 edge 状态存储所需命令子集的内存 Redis。
 */
export class FakeRedis {
  status = "ready";
  readonly strings = new Map<string, { value: string; expiresAt: number | null }>();
  readonly zsets = new Map<string, Map<string, number>>();

  private live(key: string) {
    const entry = this.strings.get(key);
    if (!entry) return null;
    if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
      this.strings.delete(key);
      return null;
    }
    return entry;
  }

  async get(key: string): Promise<string | null> {
    return this.live(key)?.value ?? null;
  }

  async set(key: string, value: string, ...args: Array<string | number>): Promise<"OK" | null> {
    let expiresAt: number | null = null;
    let nx = false;
    for (let index = 0; index < args.length; index += 1) {
      const flag = String(args[index]).toUpperCase();
      if (flag === "EX") expiresAt = Date.now() + Number(args[++index]) * 1000;
      else if (flag === "PX") expiresAt = Date.now() + Number(args[++index]);
      else if (flag === "NX") nx = true;
    }
    if (nx && this.live(key)) return null;
    this.strings.set(key, { value, expiresAt });
    return "OK";
  }

  async del(key: string): Promise<number> {
    return this.strings.delete(key) ? 1 : 0;
  }

  async expire(key: string, seconds: number): Promise<number> {
    const entry = this.live(key);
    if (!entry) return 0;
    entry.expiresAt = Date.now() + seconds * 1000;
    return 1;
  }

  async eval(_script: string, _numKeys: number, key: string, owner: string): Promise<number> {
    // 仅用于锁释放：比较 owner 后删除
    if (this.live(key)?.value === owner) {
      this.strings.delete(key);
      return 1;
    }
    return 0;
  }

  async zadd(key: string, score: number, member: string): Promise<number> {
    let set = this.zsets.get(key);
    if (!set) {
      set = new Map();
      this.zsets.set(key, set);
    }
    const existed = set.has(member);
    set.set(member, score);
    return existed ? 0 : 1;
  }

  async zrem(key: string, member: string): Promise<number> {
    return this.zsets.get(key)?.delete(member) ? 1 : 0;
  }

  async zrangebyscore(
    key: string,
    min: number,
    max: number,
    _limit?: string,
    offset = 0,
    count = Number.POSITIVE_INFINITY
  ): Promise<string[]> {
    const set = this.zsets.get(key);
    if (!set) return [];
    return Array.from(set.entries())
      .filter(([, score]) => score >= min && score <= max)
      .sort((a, b) => a[1] - b[1])
      .slice(offset, offset + count)
      .map(([member]) => member);
  }

  score(key: string, member: string): number | undefined {
    return this.zsets.get(key)?.get(member);
  }
}
