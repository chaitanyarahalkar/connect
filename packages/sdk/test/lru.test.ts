import { describe, expect, it } from 'vitest';
import { LruMap } from '../src/lru.js';

describe('LruMap', () => {
  it('rejects a non-positive capacity', () => {
    expect(() => new LruMap(0)).toThrow(RangeError);
    expect(() => new LruMap(1.5)).toThrow(RangeError);
  });

  it('evicts the least recently used entry at capacity', () => {
    const lru = new LruMap<string, number>(2);
    lru.set('a', 1);
    lru.set('b', 2);
    lru.set('c', 3);
    expect(lru.has('a')).toBe(false);
    expect(lru.get('b')).toBe(2);
    expect(lru.get('c')).toBe(3);
    expect(lru.size).toBe(2);
  });

  it('get refreshes recency so hot keys survive eviction', () => {
    const lru = new LruMap<string, number>(2);
    lru.set('a', 1);
    lru.set('b', 2);
    lru.get('a'); // now b is least recently used
    lru.set('c', 3);
    expect(lru.has('a')).toBe(true);
    expect(lru.has('b')).toBe(false);
  });

  it('overwriting an existing key does not evict and refreshes recency', () => {
    const lru = new LruMap<string, number>(2);
    lru.set('a', 1);
    lru.set('b', 2);
    lru.set('a', 10); // a becomes most recent, size stays 2
    expect(lru.size).toBe(2);
    lru.set('c', 3); // evicts b
    expect(lru.get('a')).toBe(10);
    expect(lru.has('b')).toBe(false);
  });

  it('supports delete and clear', () => {
    const lru = new LruMap<string, number>(2);
    lru.set('a', 1);
    expect(lru.delete('a')).toBe(true);
    expect(lru.delete('a')).toBe(false);
    lru.set('b', 2);
    lru.clear();
    expect(lru.size).toBe(0);
  });
});
