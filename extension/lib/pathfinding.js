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
  function buildRoute(items, startBinRaw) {
    const parsed = items.map((it, idx) => ({
      idx,
      item: it,
      bin: Bin.parseBin(it.bin)
    }));

    const routable = parsed.filter(p => p.bin.aisleKey);
    const unrouted = parsed.filter(p => !p.bin.aisleKey).map(p => p.item);

    // Group by aisle.
    const aisleMap = new Map();
    for (const p of routable) {
      if (!aisleMap.has(p.bin.aisleKey)) aisleMap.set(p.bin.aisleKey, []);
      aisleMap.get(p.bin.aisleKey).push(p);
    }

    // Deterministic aisle order along the desk->exit line (B Mod, then A Mod;
    // aisle number ascending within a mod).
    const aisleKeys = Array.from(aisleMap.keys()).sort((a, b) => {
      return Bin.aisleRank(aisleMap.get(a)[0].bin) -
             Bin.aisleRank(aisleMap.get(b)[0].bin);
    });

    // Group aisles by module, preserving the desk->exit module order.
    const byMod = new Map();
    const modOrder = [];
    for (const key of aisleKeys) {
      const mod = aisleMap.get(key)[0].bin.aisleLetter || '?';
      if (!byMod.has(mod)) { byMod.set(mod, []); modOrder.push(mod); }
      byMod.get(mod).push(key);
    }

    // The picker's start: rotate the aisle sweep *within its own module* so we
    // begin near them, but keep every module contiguous (no cross-building
    // backtracking mid-mod).
    const startBin = Bin.parseBin(startBinRaw);
    const startMod = startBin.aisleLetter;
    const startRank = startBin.aisle != null ? Bin.aisleRank(startBin) : null;

    const orderedKeys = [];
    for (const mod of modOrder) {
      let keys = byMod.get(mod);
      if (mod === startMod && startRank != null && keys.length > 1) {
        let idx = keys.findIndex(k => Bin.aisleRank(aisleMap.get(k)[0].bin) >= startRank);
        if (idx < 0) idx = 0; // start past all aisles in this mod -> keep order
        keys = keys.slice(idx).concat(keys.slice(0, idx));
      }
      for (const k of keys) orderedKeys.push(k);
    }

    // Serpentine within each aisle. Base direction toward the exit is slot
    // descending (500 -> 100); alternate each aisle to avoid re-walking.
    orderedKeys.forEach((key, i) => {
      const rows = aisleMap.get(key);
      rows.sort((a, b) => (a.bin.slot || 0) - (b.bin.slot || 0)); // ascending
      if (i % 2 === 0) rows.reverse();  // even aisles: descending (toward exit)
    });

    const stops = [];
    let order = 1;
    for (const key of orderedKeys) {
      for (const p of aisleMap.get(key)) {
        stops.push({
          order: order++,
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

    return {
      stops,
      unrouted,
      startBin,
      estAisleChanges: Math.max(0, orderedKeys.length - 1)
    };
  }

  root.QualyPath = { buildRoute };
})(typeof self !== 'undefined' ? self : this);
