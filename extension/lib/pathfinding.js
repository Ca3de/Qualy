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

    // Lay the corridors on a 1-D line by aisle number (the green-mile axis).
    // Each corridor holds both its A- and B-section bins.
    const line = Array.from(aisleMap.keys()).sort((a, b) => {
      return Bin.aisleRank(aisleMap.get(a)[0].bin) -
             Bin.aisleRank(aisleMap.get(b)[0].bin);
    });

    // Efficient direction from the start: treat the aisles as points on a line
    // and go to the NEARER end first, then sweep straight to the far end — the
    // optimal cover for points on a line from an interior start. No forced
    // desk->exit; whichever end is closer wins.
    const startBin = Bin.parseBin(startBinRaw);
    const startRank = startBin.aisle != null ? Bin.aisleRank(startBin) : null;

    let orderedKeys;
    if (startRank == null || line.length <= 1) {
      orderedKeys = line.slice();
    } else {
      const rankOf = (k) => Bin.aisleRank(aisleMap.get(k)[0].bin);
      // Split point: first aisle at/after the start position.
      let k = line.findIndex(key => rankOf(key) >= startRank);
      if (k < 0) k = line.length;                 // start past the exit end
      const below = line.slice(0, k);             // toward the desk/low end
      const above = line.slice(k);                // toward the exit/high end
      const distLow = startRank - rankOf(line[0]);
      const distHigh = rankOf(line[line.length - 1]) - startRank;

      if (distLow <= distHigh) {
        // Low end nearer: sweep down to the low end, then up to the high end.
        orderedKeys = below.slice().reverse().concat(above);
      } else {
        // High end nearer: sweep up to the high end, then down to the low end.
        orderedKeys = above.concat(below.slice().reverse());
      }
    }

    // Within a corridor, order bins along its length (desk -> exit: B section
    // then A section). Alternate direction each corridor so consecutive
    // corridors connect without re-walking.
    orderedKeys.forEach((key, i) => {
      const rows = aisleMap.get(key);
      rows.sort((a, b) => Bin.corridorDepth(a.bin) - Bin.corridorDepth(b.bin));
      if (i % 2 === 1) rows.reverse();
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
