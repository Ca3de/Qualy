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

    // Deterministic aisle order along the "line".
    const aisleKeys = Array.from(aisleMap.keys()).sort((a, b) => {
      return Bin.aisleRank(aisleMap.get(a)[0].bin) -
             Bin.aisleRank(aisleMap.get(b)[0].bin);
    });

    // Serpentine within each aisle.
    aisleKeys.forEach((key, i) => {
      const rows = aisleMap.get(key);
      rows.sort((a, b) => (a.bin.slot || 0) - (b.bin.slot || 0));
      if (i % 2 === 1) rows.reverse(); // odd aisles walked in reverse
    });

    // Where does the picker start?
    const startBin = Bin.parseBin(startBinRaw);
    let startIndex = 0;
    if (startBin.aisle != null) {
      const startRank = Bin.aisleRank(startBin);
      // First aisle at or after the start rank; else nearest by absolute rank.
      let best = 0;
      let bestDelta = Infinity;
      aisleKeys.forEach((key, i) => {
        const r = Bin.aisleRank(aisleMap.get(key)[0].bin);
        const forwardDelta = r >= startRank ? r - startRank : Infinity;
        if (forwardDelta < bestDelta) { bestDelta = forwardDelta; best = i; }
      });
      if (bestDelta === Infinity) {
        // Start is past every aisle — nearest by absolute distance.
        let absBest = 0, absDelta = Infinity;
        aisleKeys.forEach((key, i) => {
          const d = Math.abs(Bin.aisleRank(aisleMap.get(key)[0].bin) - startRank);
          if (d < absDelta) { absDelta = d; absBest = i; }
        });
        best = absBest;
      }
      startIndex = best;
    }

    // Rotate aisle order to begin at startIndex.
    const rotated = aisleKeys.slice(startIndex).concat(aisleKeys.slice(0, startIndex));

    const stops = [];
    let order = 1;
    for (const key of rotated) {
      for (const p of aisleMap.get(key)) {
        stops.push({
          order: order++,
          bin: p.bin.raw,
          aisle: (p.bin.aisleLetter || '') + (p.bin.aisle == null ? '' : p.bin.aisle),
          module: p.bin.module,
          floor: p.bin.floor,
          slot: p.bin.slot,
          item: p.item
        });
      }
    }

    return {
      stops,
      unrouted,
      startBin,
      estAisleChanges: Math.max(0, rotated.length - 1)
    };
  }

  root.QualyPath = { buildRoute };
})(typeof self !== 'undefined' ? self : this);
