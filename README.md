# EV pricer

Static single-page app listing public EV charging stations in Lithuania with city, network, address,
max power, stall count and price. Data comes from the public report on
[ev.vialietuva.lt](https://ev.vialietuva.lt/) (an XLSX file), which is downloaded and converted to JSON
by a GitHub Actions workflow every hour and published to GitHub Pages.

- Sort by any column (shift-click for multi-column sort).
- Multi-select filters for city, network, connector type and AC/DC, plus min and max power, max €/kWh and free-text search.
- Click a row for station details: every charge point with connector, power, cable and price, opening hours,
  payment methods, owner, install date, and Google Maps / directions links.
- **Map view**: List / Map toggle (`view=map` in the URL). Leaflet with OpenStreetMap tiles, loaded only when the map
  is first opened. Stations are clustered and colored by €/kWh; a marker popup shows the key facts with Details and
  Directions buttons. The map shows exactly what the current filters select, and centers on you after "Near me".
- **Near me**: on click only, asks the browser for your location, adds a distance column, sorts by it and filters to
  10 km by default (5/10/25/50 km or any distance selectable). The position stays in memory for the page view; it is never stored or put in the URL.
- **Preferences** (⚙): default Near me radius, min and max kW, max €/kWh, connectors, AC/DC, default view, and an opt-in
  "locate me automatically". Stored in the browser's localStorage. Defaults apply when the site is opened without
  filter parameters; a shared link with filters always wins. Reset returns to your defaults; "Reset filters & reload"
  clears everything, drops the cached report and reloads.
- Filters, sorting and the open station live in the URL query string, so any view can be bookmarked or shared.
- The browser caches the data for 15 minutes; the **Refresh** button forces a re-download.

## How it works

```
scripts/fetch.mjs    -> downloads the current report (discovers the /report/<id> link on the homepage)
scripts/convert.mjs  -> parses the XLSX (no dependencies) and writes site/data.json, one row per station
site/                -> index.html, app.js, style.css (Tabulator + Tom Select from jsDelivr, no build step)
.github/workflows/deploy.yml -> hourly cron + push + manual trigger; builds data.json and deploys site/ to Pages
```

The report endpoint sends no CORS headers, so the browser cannot download it directly. The workflow acts
as the fetcher and cache. If a download fails, the job fails and the previously deployed data stays live.

## Deploy to GitHub Pages (free account)

1. Create a **public** repository on GitHub (Pages and unlimited Actions minutes are free only for public repos).
2. Push this project to its `main` branch:
   ```sh
   git remote add origin git@github.com:<you>/ev-pricer.git
   git push -u origin main
   ```
3. In the repository go to **Settings → Pages** and set **Source** to **GitHub Actions**.
4. Open the **Actions** tab. The push already triggered the workflow; when it finishes the site is at
   `https://<you>.github.io/ev-pricer/`.
5. To refresh the data manually, open **Actions → Build & deploy to GitHub Pages → Run workflow**.

The cron runs at minute 17 of every hour from 06:00 to 23:59 Lithuanian time (`Europe/Vilnius`); nothing is pulled between midnight and 06:00. GitHub disables scheduled workflows in public repos after 60 days
without repository activity; the workflow re-enables itself on every scheduled run to reset that timer.

## Local development

```sh
npm run build   # download report + generate site/data.json
npm run dev     # serves site/ on http://localhost:8731
```

Requires Node 22+ and Python 3 (for the dev server only).
