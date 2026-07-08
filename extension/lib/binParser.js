// binParser.js
// Parses Amazon FC bin-location codes into structured coordinates that the
// pathfinding heuristic can order.
//
// Observed IND8 format (from Rodeo + ATLAS): "P-1-A241F363"
//   segment 0: "P"        -> module / zone letter
//   segment 1: "1"        -> floor / level
//   segment 2: "A241F363" -> aisleLetter(A) aisleNum(241) bayLetter(F) slot(363)
//
// The parser is deliberately forgiving: anything it cannot decode still
// produces an object with the raw string so callers can fall back gracefully.
//
// Exposed as `self.QualyBin` so both the background script and (if ever needed)
// content scripts can share it without a module system.

(function (root) {
  'use strict';

  // Matches the trailing "A241F363" chunk: letter, digits, letter, digits.
  const CORE_RE = /^([A-Z])(\d+)([A-Z])(\d+)$/;

  /**
   * Parse a bin code string into a structured record.
   * @param {string} raw
   * @returns {{raw:string, valid:boolean, module:?string, floor:?number,
   *            aisleLetter:?string, aisle:?number, bayLetter:?string,
   *            slot:?number, aisleKey:?string}}
   */
  function parseBin(raw) {
    const out = {
      raw: raw == null ? '' : String(raw).trim().toUpperCase(),
      valid: false,
      module: null,
      floor: null,
      aisleLetter: null,
      aisle: null,
      bayLetter: null,
      slot: null,
      aisleKey: null
    };

    if (!out.raw) return out;

    // Normalise separators: some sources use spaces instead of dashes.
    const parts = out.raw.replace(/\s+/g, '-').split('-').filter(Boolean);

    let core = null;
    if (parts.length >= 3) {
      out.module = parts[0];
      out.floor = /^\d+$/.test(parts[1]) ? parseInt(parts[1], 10) : null;
      core = parts.slice(2).join('');
    } else if (parts.length === 1) {
      // Bare core like "A241F363" or a partial aisle like "A241".
      core = parts[0];
    } else {
      core = parts.join('');
    }

    if (core) {
      const m = core.match(CORE_RE);
      if (m) {
        out.aisleLetter = m[1];
        out.aisle = parseInt(m[2], 10);
        out.bayLetter = m[3];
        out.slot = parseInt(m[4], 10);
        out.valid = true;
      } else {
        // Partial: just an aisle head e.g. "A241" or "A2".
        const partial = core.match(/^([A-Z])(\d+)/);
        if (partial) {
          out.aisleLetter = partial[1];
          out.aisle = parseInt(partial[2], 10);
        }
      }
    }

    if (out.aisleLetter != null && out.aisle != null) {
      // Stable key that groups every bin on the same aisle together.
      out.aisleKey = [
        out.module || '?',
        out.floor == null ? '?' : out.floor,
        out.aisleLetter,
        String(out.aisle).padStart(4, '0')
      ].join('|');
    }

    return out;
  }

  /**
   * Comparable numeric rank for an aisle (module+floor+letter+number) so aisles
   * can be laid out on a single line. Not physically exact — a heuristic until a
   * real mod map is supplied.
   */
  function aisleRank(bin) {
    const mod = bin.module ? bin.module.charCodeAt(0) : 0;
    const floor = bin.floor == null ? 0 : bin.floor;
    const letter = bin.aisleLetter ? bin.aisleLetter.charCodeAt(0) : 0;
    const aisle = bin.aisle == null ? 0 : bin.aisle;
    // Wide multipliers keep the components from colliding.
    return mod * 1e9 + floor * 1e7 + letter * 1e4 + aisle;
  }

  root.QualyBin = { parseBin, aisleRank, CORE_RE };
})(typeof self !== 'undefined' ? self : this);
