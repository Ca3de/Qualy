# Qualy Pick Path

A Firefox extension that turns **ATLAS pick errors** into a **curated walking
path** with item pictures. It auto-pulls Pick Rejects / Unverified Shorts from
the ATLAS OpenSearch dashboards, enriches each error with the item image from
**FC Research**, and orders the bins into an efficient route from a starting
location.

## Pipeline

```
ATLAS atlas* index (Rejects / Shorts)
   → errors: bin, fnsku, asin, item_name, quantity, reject_reason, AA (user_id), LPN
        → FC Research  POST /{WH}/results/product  body s={fnsku}
             → item image (m.media-amazon.com) + title / weight / dimensions
        → parse bin codes (P-1-A241F363 → module/floor/aisle/slot)
             → serpentine route from your start bin
                  → Pick Path page: ordered stops, images, FC Research + Rodeo links
                       → Confirmation walk: step each stop, confirm/deny (+reason)
                            → downloadable .md verification report
```

## How each piece works

### 1. ATLAS (errors)
Three ways to pull, in order of robustness:

1. **Direct API (default).** The background script POSTs to
   `…/_dashboards/internal/search/opensearch` (same session cookies) against the
   `atlas*` index:
   ```
   query_string: warehouse_id:{WH} AND type:(SHORT OR REJECT)
   filter:       timestamp within the lookback window
   size: 5000, sort: timestamp desc
   ```
   It reads `hits.hits[]._source` for `bin`/`bin_raw`, `fnsku`, `asin`,
   `item_name`, `quantity`, `reject_reason`, `type`. No dashboard rendering or
   pagination needed, and it gets **both** error feeds at once. You choose the
   error type (Shorts / Rejects / both) and lookback hours in the UI.
2. **Scrape (fallback).** A content script on
   `moc.prod.atlas-opensearch.qubit.amazon.dev/_dashboards/*` scrapes the
   rendered saved-search table, mapping **columns by header name** and preferring
   the untruncated `bin_raw` / `asin_raw` columns. Supported dashboards:
   - **Pick Rejects** — `asin, fnsku, bin_raw, quantity, reject_reason, item_name, binding_name`
   - **Unverified Pick Shorts** — `warehouse_id, bin, fnsku, item_name, quantity, asin_raw`
3. **CSV/TSV paste (last resort).** Paste the dashboard's CSV export into the
   Pick Path page.

> The Shorts feed is confirmed as `type:SHORT`; Rejects is assumed `type:REJECT`.
> If your reject rows use a different `type` value, switch to "Shorts only" or
> use the scrape/paste path and tell me the value to correct the default.

### 2. FC Research (images)
The background script POSTs to
`https://fcresearch-na.aka.amazon.com/{WH}/results/product` with `s={fnsku}`
(credentials included, same session as your browser). It parses the product
fragment for:

- the item `<img src="https://m.media-amazon.com/images/...">` (fetched as a
  data URL so it renders even under the page CSP), and
- ASIN, Title, Weight, Dimensions, Binding.

> FC Research's `s=` accepts FNSKU/ASIN/LPN — the image lookup keys off the
> FNSKU (falling back to ASIN).

### 2b. AA + LPN (who + which unit)
From the same ATLAS `_source` the extension also reads the **AA** (associate
login, field `user_id`) and the **LPN**. The AA field is confirmed; the LPN
field name is pulled best-effort across likely keys (`lpn`, `pick_lpn`,
`from_lpn`, `license_plate`, `container_id`, …). Both appear on the stop cards
and in the confirmation walk / report.

### 3. Pathfinding (route)
`lib/binParser.js` decodes `P-1-A241F363` using the confirmed IND8 geometry:

| Segment | Meaning |
|---|---|
| `A` | **Module** — A Mod / B Mod |
| `241` | **Aisle number** (cross-axis, map 100–266) |
| `F` | **Shelf level** — `A`=bottom … `G`=top (**A & G are locked**, need a key) |
| `363` | **Position along the aisle** — 500 (desk) … 100 (midpoint), mirrored per mod |

`lib/pathfinding.js` orders the stops along the real **desk→exit** walk:

1. **B Mod before A Mod** (desk side → exit side), each module kept contiguous.
2. Within a module, sweep aisles and **serpentine the slots** (base direction
   500→100 toward the exit, alternating each aisle).
3. Rotate the sweep **within the start bin's module** so the route begins near
   the picker without splitting a module.

Bins on locked levels (A/G) are flagged with 🔒 so the picker knows a key is
needed. A cleaner mod map could later add exact walk-distance along the green
highways, but the ordering above matches how IND8 is actually walked.

### 4. Confirmation walk + report
Once a route is built, **Start confirmation walk** steps through the stops one
at a time. Each card shows the next location, error type (reject/short), LPN,
AA, item image + details, and two actions:

- **Confirm error** — records it as a real error.
- **Deny** — prompts for a reason, then records it.

After the last stop, a summary appears with a **Download report (.md)** button.
The report lists every checked item (result, bin, aisle, error type, LPN, AA,
ASIN/FNSKU, item, qty, reason) plus confirmed/denied counts.

## Usage

1. Open an ATLAS **Rejects** or **Shorts** dashboard (buttons in the popup) so
   you're authenticated to ATLAS.
2. In the floating **🧭 Qualy Pick Path** panel, type a start bin
   (e.g. `P-1-A200C300`), pick error type + lookback, and click
   **Pull from ATLAS & build path**.
3. The Pick Path tab opens with the ordered stops: bin, item image, item name,
   LPN, AA, ASIN/FNSKU, quantity, reject reason, FC Research / Rodeo links.
4. Click **Start confirmation walk**, confirm/deny each stop, then download the
   `.md` report.

## Install (Firefox, temporary)

1. `about:debugging` → **This Firefox** → **Load Temporary Add-on…**
2. Select `extension/manifest.json`.

## Permissions

- `moc.prod.atlas-opensearch.qubit.amazon.dev` — read the error dashboards
- `fcresearch-na.aka.amazon.com` — item image + details
- `rodeo-iad.amazon.com` — deep links
- `m.media-amazon.com` / `images-na.ssl-images-amazon.com` — item images

## Project structure

```
extension/
├── manifest.json
├── background.js            # FC Research fetch + routing orchestration
├── lib/
│   ├── binParser.js         # bin code → coordinates
│   └── pathfinding.js       # serpentine route
├── content/
│   ├── atlas.js             # dashboard scraper + floating panel
│   └── atlas.css
├── page/
│   ├── path.html/.css/.js   # curated path results view (+ CSV paste fallback)
└── popup/
    └── popup.html/.css/.js
```

## Roadmap

- Swap the serpentine heuristic for an exact route once the IND8 mod map lands.
- Confirm the Rejects `type` value (assumed `REJECT`) against live data.
