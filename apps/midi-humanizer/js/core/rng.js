/**
 * シード付き乱数。同じシードなら同じ結果になる（再現性の確保）。
 */
(function (root) {
  'use strict';
  const MH = (root.MH = root.MH || {});

  function hashSeed(seed) {
    const s = String(seed);
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0 || 1;
  }

  /** mulberry32 + Box-Muller による正規乱数 */
  function createRng(seed) {
    let state = hashSeed(seed);
    function next() {
      state = (state + 0x6d2b79f5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }
    let spare = null;
    function normal() {
      if (spare !== null) {
        const v = spare;
        spare = null;
        return v;
      }
      let u, v, r;
      do {
        u = next() * 2 - 1;
        v = next() * 2 - 1;
        r = u * u + v * v;
      } while (r === 0 || r >= 1);
      const m = Math.sqrt((-2 * Math.log(r)) / r);
      spare = v * m;
      return u * m;
    }
    /** 標準偏差sdの正規乱数。外れ値で破綻しないよう±2.5σで打ち切る */
    function gauss(sd) {
      if (!sd) return 0;
      return Math.max(-2.5, Math.min(2.5, normal())) * sd;
    }
    function range(a, b) {
      return a + (b - a) * next();
    }
    return { next, gauss, range };
  }

  MH.createRng = createRng;
})(typeof window !== 'undefined' ? window : globalThis);
