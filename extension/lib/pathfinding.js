// pathfinding.js
// Turns a set of error bins into a near-optimal walking order.
//
// Geometry (from the IND8 floor map):
//   - A "green mile" highway runs horizontally across the whole floor.
//   - A mod is above it, B mod below it; aisle NUMBER is the horizontal axis.
//   - slot 500 sits against the green mile; slot decreases away from it
//     (A toward the exit above, B toward the desk below). So a bin's depth into
//     the rack from the highway is (500 - slot).
//   - You travel along the green mile, then dip into an aisle. Crossing from A
//     to B (or deep dips) costs the real distance out-and-in.
//
// Distance between two bins (in approximate map pixels):
//   same aisle & same side : |depth_a - depth_b|
//   otherwise              : depth_a + horizontal(|aisle_a - aisle_b|) + depth_b
//
// Route = nearest-neighbour tour from the start, improved with 2-opt. For the
// handful of error bins in a checklist this is effectively optimal, and it needs
// no fixed direction or finish side.
//
// Depends on self.QualyBin (binParser.js loaded first).

(function (root) {
  'use strict';

  const Bin = root.QualyBin;

  // Map scale: ~15px between adjacent aisle numbers, ~0.6px per slot unit.
  // Horizontal travel dominates; depth matters mainly for A<->B crossings.
  const AISLE_PX = 15;
  const SLOT_PX = 0.6;
  // The green mile sits at the high-slot end (slots run ~100..570, 500+ against
  // the mile). Depth into the rack from the highway = distance below this.
  const MILE_SLOT = 600;
  const depthPx = (slot) => Math.max(0, MILE_SLOT - (slot == null ? 300 : slot)) * SLOT_PX;

  function pos(bin) {
    return {
      aisle: bin.aisle == null ? 0 : bin.aisle,
      side: bin.aisleLetter === 'A' ? 'A' : 'B',   // default unknown -> B (desk)
      slot: bin.slot == null ? 300 : bin.slot
    };
  }

  function dist(a, b) {
    const depthA = depthPx(a.slot);
    const depthB = depthPx(b.slot);
    if (a.aisle === b.aisle && a.side === b.side) {
      return Math.abs(depthA - depthB);
    }
    return depthA + Math.abs(a.aisle - b.aisle) * AISLE_PX + depthB;
  }

  /**
   * @param {Array<{bin:string, [k:string]:any}>} items  error records (each has a `bin`).
   * @param {string} startBinRaw  the picker's starting bin (or aisle).
   * @returns {{stops:Array, unrouted:Array, startBin:object, crossings:number}}
   */
  function buildRoute(items, startBinRaw) {
    const parsed = items.map((it) => ({ item: it, bin: Bin.parseBin(it.bin) }));
    const nodes = parsed.filter(p => p.bin.aisle != null).map(p => ({ p, pos: pos(p.bin) }));
    const unrouted = parsed.filter(p => p.bin.aisle == null).map(p => p.item);

    const startBin = Bin.parseBin(startBinRaw);
    let origin;
    if (startBin.aisle != null) {
      origin = pos(startBin);
    } else if (nodes.length) {
      // No start given: begin from the desk corner (lowest aisle, B, slot 100).
      const minAisle = Math.min.apply(null, nodes.map(n => n.pos.aisle));
      origin = { aisle: minAisle, side: 'B', slot: 100 };
    } else {
      origin = { aisle: 0, side: 'B', slot: 100 };
    }

    // Order the stops. Held-Karp is exact (guaranteed shortest open path from
    // the start) and is cheap for the handful of bins in a checklist; for large
    // sets fall back to nearest-neighbour + 2-opt.
    let tour;
    if (nodes.length === 0) {
      tour = [];
    } else if (nodes.length <= 13) {
      tour = heldKarp(nodes, origin);
    } else {
      tour = nearestNeighbour(nodes, origin);
      twoOpt(tour, origin);
    }

    const stops = [];
    let n = 1;
    let crossings = 0;
    let prevSide = origin.side;
    for (const node of tour) {
      const b = node.p.bin;
      if (b.aisleLetter && b.aisleLetter !== prevSide) { crossings++; prevSide = b.aisleLetter; }
      stops.push({
        order: n++,
        bin: b.raw,
        aisle: (b.aisleLetter || '') + (b.aisle == null ? '' : b.aisle),
        mod: b.mod,
        floor: b.floor,
        slot: b.slot,
        level: b.level,
        locked: b.locked,
        item: node.p.item
      });
    }

    return { stops, unrouted, startBin, crossings };
  }

  // Exact shortest open path from `origin` through all nodes (Held-Karp DP).
  function heldKarp(nodes, origin) {
    const n = nodes.length;
    const D = new Float64Array(n);              // origin -> i
    const M = [];                               // i -> j
    for (let i = 0; i < n; i++) {
      D[i] = dist(origin, nodes[i].pos);
      const row = new Float64Array(n);
      for (let j = 0; j < n; j++) row[j] = dist(nodes[i].pos, nodes[j].pos);
      M.push(row);
    }
    const size = 1 << n;
    const dp = new Float64Array(size * n).fill(Infinity);
    const par = new Int16Array(size * n).fill(-1);
    for (let j = 0; j < n; j++) dp[((1 << j) * n) + j] = D[j];
    for (let mask = 1; mask < size; mask++) {
      for (let j = 0; j < n; j++) {
        if (!(mask & (1 << j))) continue;
        const cur = dp[mask * n + j];
        if (cur === Infinity) continue;
        for (let k = 0; k < n; k++) {
          if (mask & (1 << k)) continue;
          const nm = mask | (1 << k);
          const nc = cur + M[j][k];
          if (nc < dp[nm * n + k]) { dp[nm * n + k] = nc; par[nm * n + k] = j; }
        }
      }
    }
    const full = size - 1;
    let bj = 0, bc = Infinity;
    for (let j = 0; j < n; j++) if (dp[full * n + j] < bc) { bc = dp[full * n + j]; bj = j; }
    const order = [];
    let mask = full, j = bj;
    while (j !== -1) { order.push(nodes[j]); const pj = par[mask * n + j]; mask ^= (1 << j); j = pj; }
    order.reverse();
    return order;
  }

  function nearestNeighbour(nodes, origin) {
    const remaining = nodes.slice();
    const tour = [];
    let cur = origin;
    while (remaining.length) {
      let bi = 0, bd = Infinity;
      for (let i = 0; i < remaining.length; i++) {
        const d = dist(cur, remaining[i].pos);
        if (d < bd) { bd = d; bi = i; }
      }
      tour.push(remaining[bi]);
      cur = remaining[bi].pos;
      remaining.splice(bi, 1);
    }
    return tour;
  }

  function twoOpt(tour, origin) {
    const len = tour.length;
    if (len < 3) return;
    const nodeAt = (idx) => (idx < 0 ? origin : tour[idx].pos);
    let improved = true;
    let guard = 0;
    while (improved && guard++ < 50) {
      improved = false;
      for (let i = 0; i < len - 1; i++) {
        for (let k = i + 1; k < len; k++) {
          const A = nodeAt(i - 1);
          const B = tour[i].pos;
          const C = tour[k].pos;
          const D = (k + 1 < len) ? tour[k + 1].pos : null;
          const before = dist(A, B) + (D ? dist(C, D) : 0);
          const after = dist(A, C) + (D ? dist(B, D) : 0);
          if (after + 1e-9 < before) {
            reverse(tour, i, k);
            improved = true;
          }
        }
      }
    }
  }

  function reverse(arr, i, k) {
    while (i < k) { const t = arr[i]; arr[i] = arr[k]; arr[k] = t; i++; k--; }
  }

  root.QualyPath = { buildRoute, _dist: dist };
})(typeof self !== 'undefined' ? self : this);
