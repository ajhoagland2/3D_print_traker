# Artaic Print Planner

Internal static web application for planning 3D print production from uploaded G-code files.

Version 1 runs entirely in the browser and is designed for GitHub Pages hosting. There is no required backend server, account system, or cloud database.

## Features

- Upload one or more `.gcode` files.
- Parse local G-code metadata for print time, filament usage, material usage, toolhead usage, and estimated completion.
- Track filament inventory by material, color, brand, spool weight, remaining weight, cost, and storage location.
- Estimate print costs by job, material, and full project.
- Recommend a weekly print schedule based on printers, operating hours, deadlines, material changeovers, and overnight windows.
- Persist jobs, inventory, and schedule settings in browser LocalStorage.
- Keep parsing, storage, costing, and scheduling in separate modules for future backend migration.

## Repository Structure

```text
.
├── index.html
├── src
│   ├── main.js
│   ├── styles.css
│   ├── modules
│   │   ├── costing.js
│   │   ├── gcodeParser.js
│   │   ├── inventory.js
│   │   ├── scheduler.js
│   │   └── storage.js
│   └── ui
│       └── render.js
├── docs
│   └── architecture.md
└── .github
    └── workflows
        └── pages.yml
```

## Local Use

Open `index.html` in a browser. Because the app is plain HTML, CSS, and JavaScript, no package installation is required for Version 1.

For local static hosting, any simple static server works:

```bash
python -m http.server 5173
```

Then open `http://localhost:5173`.

## GitHub Pages Deployment

1. Push this repository to GitHub.
2. In GitHub, open **Settings > Pages**.
3. Set the source to **GitHub Actions**.
4. Push to `main`.
5. The included workflow in `.github/workflows/pages.yml` will publish the static site.

The app uses relative asset paths, so it works under a GitHub Pages project URL such as:

```text
https://ajhoagland2.github.io/3D_print_traker/
```

## Data Persistence

Version 1 stores data in `window.localStorage` under the key `artaic-print-planner-v1`. Data remains local to the browser and can be cleared from the app.

## Future Backend Migration

The app is organized around small service modules:

- `storage.js` can be swapped for an API-backed repository.
- `gcodeParser.js` can move to a worker or server-side import pipeline.
- `costing.js` can be connected to ERP pricing.
- `scheduler.js` can evolve into a multi-printer optimization service.
- `render.js` can later be replaced by React/Vite components without changing the domain logic.
