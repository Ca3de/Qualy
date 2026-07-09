// pathfinding.js
// Turns a set of error bins into a walking order.
//
// v1 heuristic: SERPENTINE.
//   1. Parse every bin into {module, floor, aisle, slot}.
//   2. Lay the aisles out on one line (aisleRank) and visit them in order.
//   3. Snake the slots: even aisles low->high, odd aisles high->low, so you
//      never walk an aisle end-to-end twice.
//   4. Rotate the sequence so it *starts* at the aisle nearest the picker's
//      start bin, then continues forward through the mod and wraps around for
//      anything behind the start.
//
// This needs no physical map. When a real mod/aisle adjacency map is provided
// later, only `orderAisles()` has to change.
//
// Depends on self.QualyBin (binParser.js loaded first).

(function (root) {
  'use strict';

  const Bin = root.QualyBin;

  /**
   * @param {Array<{bin:string, [k:string]:any}>} items  error records; each must
   *        carry a `bin` string. Extra fields are preserved on output.
   * @param {string} startBinRaw  the picker's starting bin (or aisle).
   * @returns {{stops:Array, unrouted:Array, startBin:object, estAisleChanges:number}}
   */
  // Sweep a set of aisle numbers from a start aisle: go to the nearer end
  // first, then straight to the far end. Same reference used for both sides so
  // the whole walk keeps one direction.
  function sweepNearest(aisles, from) {
    const sorted = aisles.slice().sort((a, b) => a - b);
    if (from == null || sorted.length <= 1) return sorted;
    let k = sorted.findIndex(a => a >= from);
    if (k < 0) k = sorted.length;
    const below = sorted.slice(0, k);
    const above = sorted.slice(k);
    const distLow = from - sorted[0];
    const distHigh = sorted[sorted.length - 1] - from;
    return distLow <= distHigh
      ? below.slice().reverse().concat(above)   // nearer low end first
      : above.concat(below.slice().reverse());  // nearer high end first
  }

  function buildRoute(items, startBinRaw) {
    const parsed = items.map((it, idx) => ({ idx, item: it, bin: Bin.parseBin(it.bin) }));
    const routable = parsed.filter(p => p.bin.aisle != null);
    const unrouted = parsed.filter(p => p.bin.aisle == null).map(p => p.item);

    const startBin = Bin.parseBin(startBinRaw);
    const startAisle = startBin.aisle;   // number or null
    const startSide = startBin.mod;      // 'A' | 'B' | null

    // Partition by side (A near exit, B near desk). The green mile between the
    // sides is expensive to cross, so we do one side fully, cross once, then the
    // other — never bouncing back and forth.
    const sides = { A: [], B: [], '?': [] };
    for (const p of routable) {
      sides[(p.bin.mod === 'A' || p.bin.mod === 'B') ? p.bin.mod : '?'].push(p);
    }

    // Do the start's side first (0 extra crossings), then the other side, then
    // any unknown-mod bins. Empty sides are skipped.
    let order = startSide === 'A' ? ['A', 'B', '?']
             : startSide === 'B' ? ['B', 'A', '?']
             : ['B', 'A', '?'];                     // default: desk side first
    order = order.filter(s => sides[s].length);

    const stops = [];
    let n = 1;
    let corridorCount = 0;
    for (const side of order) {
      // Group this side by aisle number.
      const byAisle = new Map();
      for (const p of sides[side]) {
        if (!byAisle.has(p.bin.aisle)) byAisle.set(p.bin.aisle, []);
        byAisle.get(p.bin.aisle).push(p);
      }
      // Both sides sweep from the SAME start aisle (the crossing sits near the
      // start/desk), so the walk holds one direction instead of zig-zagging.
      const aisles = sweepNearest(Array.from(byAisle.keys()), startAisle);
      for (const a of aisles) {
        corridorCount++;
        const rows = byAisle.get(a);
        rows.sort((r1, r2) => (r1.bin.slot || 0) - (r2.bin.slot || 0)); // dip order
        for (const p of rows) {
          stops.push({
            order: n++,
            bin: p.bin.raw,
            aisle: (p.bin.aisleLetter || '') + (p.bin.aisle == null ? '' : p.bin.aisle),
            mod: p.bin.mod,
            floor: p.bin.floor,
            slot: p.bin.slot,
            level: p.bin.level,
            locked: p.bin.locked,
            item: p.item
          });
        }
      }
    }

    return {
      stops,
      unrouted,
      startBin,
      crossings: Math.max(0, order.filter(s => s !== '?').length - 1),
      estAisleChanges: Math.max(0, corridorCount - 1)
    };
  }

  root.QualyPath = { buildRoute };
})(typeof self !== 'undefined' ? self : this);
