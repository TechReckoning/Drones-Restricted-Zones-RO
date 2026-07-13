# Drones Restricted Zones RO 🛰️

Interactive web app for **UAV / drone restricted airspace in Romania**, built on
the official [ROMATSA](https://www.romatsa.ro/) restricted-zones dataset.

- 🗺️ **Map** of all restricted zones (OpenStreetMap base + Leaflet).
- 📋 **Zone list** on the right with altitude limits and ATC contact per zone.
  Click a zone in the list to highlight it on the map, or click it on the map to
  highlight it in the list — the selection is synced both ways.
- ✏️ **Draw your flying zone** on the left panel. When you finish drawing, the app
  shows:
  - the exact **coordinates** (WGS84 lat/lon) of every vertex,
  - the **restricted zones your flight overlaps**, with their altitude limits,
    status and contact details,
  - a one-click **export to `.KML`** (opens in Google Earth, Mission Planner,
    DJI/Litchi, etc.) — the flying zone plus any overlapping restricted zones.

> ⚠️ **Not for operational use.** This is an unofficial visualization aid. Always
> verify against the official ROMATSA source and current NOTAMs before any flight.

## Data source

Restricted zones are pulled live from the official ROMATSA feed:

```
https://flightplan.romatsa.ro/init/static/zone_restrictionate_uav.json
```

The backend (`server.js`) proxies this endpoint because it does not send CORS
headers, so a browser cannot fetch it directly. Responses are cached for one hour
and mirrored to `data/zones.snapshot.json`, which is used as an offline fallback
if the live source is unreachable. Use the **↻ Refresh** button (or `GET
/api/zones?refresh=1`) to force a fresh fetch.

## Tech stack

| Layer     | Choice |
|-----------|--------|
| Backend   | Node.js + Express (static hosting + `/api/zones` proxy/cache) |
| Map       | [Leaflet](https://leafletjs.com/) + OpenStreetMap tiles |
| Drawing   | [Leaflet-Geoman](https://geoman.io/) |
| Geometry  | [Turf.js](https://turfjs.org/) (overlap detection, area) |
| Export    | Custom KML writer (`public/js/kml.js`) |

Front-end libraries are loaded from a CDN; the only npm dependency is Express.

## Running locally

Requires Node.js ≥ 18.

```bash
npm install
npm start
# open http://localhost:3000
```

For auto-reload during development:

```bash
npm run dev
```

Set a custom port with `PORT=8080 npm start`.

## Project layout

```
server.js                     Express app: static hosting + /api/zones proxy
data/zones.snapshot.json      Offline fallback copy of the ROMATSA dataset
public/
  index.html                  Three-panel layout (draw · map · zone list)
  css/styles.css
  js/app.js                   Map, list sync, drawing, overlap analysis
  js/kml.js                   KML document generation + download
```

## API

- `GET /api/zones` — returns `{ meta, geojson }`. `meta.source` is one of
  `live`, `live-cache`, `stale-cache`, `snapshot`. Add `?refresh=1` to bypass the
  cache.
- `GET /api/health` — basic liveness / cache status.

## License

MIT. Restricted-zone data © ROMATSA.
