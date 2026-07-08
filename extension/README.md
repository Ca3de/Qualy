# Qualy Pick Path

A Firefox extension that turns **ATLAS pick errors** into a **curated walking
path** with item pictures. It auto-pulls Pick Rejects / Unverified Shorts from
the ATLAS OpenSearch dashboards, enriches each error with the item image from
**FC Research**, and orders the bins into an efficient route from a starting
location.

## Pipeline

```
ATLAS dashboard (Rejects / Shorts)
   → scrape rows: bin_raw, fnsku, asin, item_name, quantity, reject_reason
        → FC Research  POST /{WH}/results/product  body s={fnsku}
             → item image (m.media-amazon.com) + title / weight / dimensions
        → parse bin codes (P-1-A241F363 → module/floor/aisle/slot)
             → serpentine route from your start bin
                  → Pick Path page: ordered stops, images, FC Research + Rodeo links
```

## How each piece works

### 1. ATLAS (errors)
Runs a content script on
`moc.prod.atlas-opensearch.qubit.amazon.dev/_dashboards/*`. It scrapes the
saved-search table, mapping **columns by header name** (so it survives column
reordering) and preferring the untruncated `bin_raw` / `asin_raw` columns. Two
dashboards are supported:

- **Pick Rejects** — `asin, fnsku, bin_raw, quantity, reject_reason, item_name, binding_name`
- **Unverified Pick Shorts** — `warehouse_id, bin, fnsku, item_name, quantity, asin_raw`

If a page's table can't be scraped (virtualised grid, etc.), the Pick Path page
has a **CSV/TSV paste box** as a fallback — paste the dashboard's CSV export.

### 2. FC Research (images)
The background script POSTs to
`https://fcresearch-na.aka.amazon.com/{WH}/results/product` with `s={fnsku}`
(credentials included, same session as your browser). It parses the product
fragment for:

- the item `<img src="https://m.media-amazon.com/images/...">` (fetched as a
  data URL so it renders even under the page CSP), and
- ASIN, Title, Weight, Dimensions, Binding.

> ATLAS exposes FNSKU/ASIN rather than LPN, and FC Research's `s=` accepts
> either — so the lookup keys off the FNSKU (falling back to ASIN).

### 3. Pathfinding (route)
`lib/binParser.js` decodes bins like `P-1-A241F363` into
`module=P, floor=1, aisle=A241, slot=363`. `lib/pathfinding.js` then applies a
**serpentine heuristic**:

1. group bins by aisle, order aisles along a line,
2. snake the slots (alternate direction each aisle),
3. rotate so the route **starts at the aisle nearest your start bin** and wraps
   around for anything behind it.

No warehouse map is needed. When a real IND8 mod/aisle adjacency map is
available, only `orderAisles()` in `pathfinding.js` has to change for an exact
route.

## Usage

1. Open an ATLAS **Rejects** or **Shorts** dashboard (buttons in the popup).
2. In the floating **🧭 Qualy Pick Path** panel, type a start bin
   (e.g. `P-1-A200C300`) and click **Pull errors & build path**.
3. The Pick Path tab opens with the ordered stops: bin, item image, item name,
   ASIN/FNSKU, quantity, reject reason, and FC Research / Rodeo links.

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
- Optional direct ATLAS API mode (`/_dashboards/internal/search/opensearch`)
  to pull errors without the dashboard open.
