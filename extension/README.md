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
   filter:       timestamp within the chosen window
   size: 5000, sort: timestamp desc
   ```
   It reads `hits.hits[]._source` for `bin`/`bin_raw`, `fnsku`, `asin`,
   `item_name`, `quantity`, `reject_reason`, `type`. No dashboard rendering or
   pagination needed, and it gets **both** error feeds at once. You choose the
   error type (Shorts / Rejects / both) and the **time range**:
   - **Last X hours** — rolling window.
   - **Night shift** — 18:00→06:00 overnight: the window containing (or most
     recently containing) now.
   - **Day shift** — 06:00→18:00 today.
   - **Custom** — pick exact from/to date-times.

   Shift windows are computed from the associate's wall clock (= FC local time)
   and sent to ATLAS as absolute UTC instants.
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

### 2b. AA + LPN + manager (who + which unit)
From the same ATLAS `_source` the extension also reads the **AA** (associate
login, `user_id`), the **manager** (`manager`), and the **LPN** (`lpn`). All
three appear on the stop cards and in the confirmation walk / report.

### 3. Pathfinding (route)
`lib/binParser.js` decodes `P-1-A241F363` using the confirmed IND8 geometry:

| Segment | Meaning |
|---|---|
| `A` | **Module** — A Mod / B Mod |
| `241` | **Aisle number** (cross-axis, map 100–266) |
| `F` | **Shelf level** — `A`=bottom … `G`=top (**A & G are locked**, need a key) |
| `363` | **Position along the aisle** — 500 (desk) … 100 (midpoint), mirrored per mod |

**Geometry:** the aisle *number* is the corridor. A-section (near the exit) and
B-section (near the desk) of the same number are two halves of the **same
corridor**, split by the "green mile" highway — so `A112` and `B112` are on the
same line. Pickers travel the green mile horizontally by aisle number and dip up
into A or down into B.

`lib/pathfinding.js` solves for the **shortest walk**, no fixed direction or
finish side. Each bin is placed on the map with scales measured off the floor
plan — **15 px per aisle number, 0.6 px per slot** — with aisles 100–138 (left
block) then 143–266 (right block) separated by a **divider gap** (139–142 don't
exist). `x` = aisle position, depth into the rack = `600 − slot` (the green mile
is the high-slot highway). Distance between two bins: same aisle & side →
`|Δdepth|`; otherwise → `depth_a + |Δx| + depth_b` (out to the mile, along it,
back in). Deep A↔B crossings cost their real distance; horizontal travel
dominates.

The route is the **shortest open path from your start** through all bins:
- **≤13 bins → exact** (Held-Karp DP — provably optimal).
- **more → nearest-neighbour + 2-opt** (near-optimal, sub-millisecond).

The status line shows the stop count and how many green-mile crossings the
optimal route needed.

Bins on locked levels are flagged with 🔒 so the picker knows a key is needed.
The bottom shelf is always `A`; the top letter varies by aisle (`G` on some,
`L` on others), so `A`, `G`, and `L` are treated as locked. A cleaner mod map
could later add exact walk-distance along the green highways, but the ordering
above matches how IND8 is actually walked.

### UI: stays out of the way
On the ATLAS dashboards the extension shows only a small round **logo button**
in the corner (collapsed by default). Click it to open the control panel; the
"–" button collapses it again. The open/closed state is remembered.

### 4. Confirmation walk + report
Once a route is built, **Start confirmation walk** steps through the stops one
at a time. Each card shows the next location, error type (reject/short), LPN,
AA, item image + details, and two actions:

- **Note (optional)** — a text box above the buttons; add any note, then Confirm
  or Deny as usual. Captured on the item and shown in the report's Note column.
- **Confirm error** — records it as a real error. **Rejects also prompt for a
  reason on confirm** (shorts confirm with no reason).
- **Deny** — prompts for a reason, then records it (both shorts and rejects).

Each stop card also has a **✓ Mark checked** button to decide a single item out
of walk order (e.g. one you already checked) — it's remembered and included in
the report just like a walked item.

After the last stop, a summary appears with a **Download report (.md)** button.
The report lists every checked item (result, bin, aisle, error type, LPN, AA,
manager, ASIN/FNSKU, item, qty, reason) plus confirmed/denied counts.

### 5. Auto-crawl (continuous mode)
Tick **Auto-crawl** and the page re-queries ATLAS every N minutes and **merges
only new errors into the checklist** (dedup by bin+LPN+time). New errors are
**appended to the end** of the route (never inserted ahead of the stop you're
checking); the walk you're on is left untouched. Only the **Build path** button
re-optimizes the whole route from scratch. Checked errors and
their decisions are kept permanently for the session, so a crawl **never
re-surfaces an error you already checked** — even after its report has been
downloaded (the same doc keeps coming back from ATLAS while it's inside the time
window; the extension remembers it). The checklist, decisions, and start bin are
persisted, so a reload resumes right where you left off. Decisions show live on
the cards (✓ confirmed / ✕ denied). Checked cards are **hidden by default** to
keep the list uncluttered — a "N checked hidden — click to show" note (and the
**Show checked** toggle) reveals them when needed. When you finish the pending
items, the report
**auto-downloads**; each report is the **delta** of newly-checked items since the
last one. **Clear checklist** resets everything for a fresh start (e.g. new
shift).

### 6. Slack notifications
Open **🔔 Slack notifications**, paste a Slack webhook URL, set the threshold
(default every 5), and enable. Each time N new pick errors arrive (from a crawl,
fetch, or paste) a Slack message lists the new bins/items. Sent from the
background script (which holds the `hooks.slack.com` host permission), so no page
CORS issue. Only errors arriving after the page loads count (the initial backfill
is not spammed). **Send test** verifies the webhook.

Two webhook types are supported (auto-detected by URL):

- **Workflow webhook** (`hooks.slack.com/triggers/…`) — no app/admin approval
  needed. In **Workflow Builder**: start with *“Starts with a webhook”*, add a
  **Text** variable (default name `message`), add a step that posts that variable
  to a channel, publish, and copy the URL. Put the variable's name in **Message
  variable name**. The extension sends `{ "<varName>": "<message>" }`.
- **Incoming Webhook** (`hooks.slack.com/services/…`) — the classic app webhook.
  The extension sends `{ "text": "<message>" }`.

## Permissions (added)

- `hooks.slack.com` — post notification messages to your Slack webhook.

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
