# Manufacturing Estimator

Privacy-first web application for planning 3D print production from manufacturing metrics extracted from customer-controlled files.

Version 1 runs entirely in the browser and is designed for GitHub Pages hosting. There is no required backend server, account system, or cloud database.

## Product Vision

Manufacturing Estimator is designed for engineering firms, additive manufacturing businesses, fabrication shops, product designers, and manufacturers whose intellectual property is often contained within STL, 3MF, and G-code files.

The non-negotiable architectural constraint is:

> Your geometry files stay with you. We only need the manufacturing metrics.

The platform must be architected around the principle that customer manufacturing files remain under customer control whenever possible.

## Core Value Proposition

Manufacturing Estimator turns local manufacturing file analysis into production planning data without requiring raw geometry files to be stored on company servers by default.

The product should consistently communicate:

> Your files stay with you. Your data is not for sale. Your subscription funds the software.

Acceptable stored metrics include print time, filament consumption, material type, material cost, project name, scheduling information, inventory information, and production statistics. Raw STL geometry, CAD models, mesh data, proprietary part geometry, customer design files, and raw uploaded manufacturing files should not be stored by default.

## Privacy Requirements

STL, 3MF, and G-code processing should occur locally in the user's browser whenever technically feasible. Raw geometry files should not be permanently stored on company servers by default, used for machine learning training, sold, shared, licensed, distributed, or accessed by company employees except through explicit customer-authorized support workflows.

Privacy messaging must appear across the landing page, pricing page, privacy policy, FAQ, and account onboarding flow:

- Your manufacturing files are analyzed locally.
- Your geometry files remain under your control.
- We do not sell customer data.
- We do not use customer files for AI training.
- We store manufacturing metrics, not proprietary geometry.
- Your subscription pays for the software, not through monetization of your data.

## Features

- Upload one or more `.gcode` files.
- Parse local G-code metadata for print time, filament usage, material usage, toolhead usage, and estimated completion.
- Track filament inventory by material, color, brand, spool weight, remaining weight, cost, and storage location.
- Estimate print costs by job, material, and full project.
- Recommend a weekly print schedule based on printers, operating hours, deadlines, material changeovers, and overnight windows.
- Persist jobs, inventory, and schedule settings in browser LocalStorage.
- Keep parsing, storage, costing, and scheduling in separate modules for future backend migration.
- Present privacy-first landing, pricing, FAQ, and onboarding messaging in the application shell.

## Subscription Tiers

- Starter ($9/month): Local G-code analysis, basic inventory management, basic scheduling, and local customer file processing.
- Professional ($29/month): Local STL, 3MF, and G-code analysis, cloud synchronization of extracted metrics, team collaboration, advanced scheduling, and inventory forecasting.
- Business ($99/month): Shared company workspaces, audit logging, advanced reporting, role-based permissions, and cloud synchronization of extracted metrics only.
- Enterprise (custom): Self-hosted deployment, customer-controlled infrastructure, on-premise processing, SSO integration, customer-owned databases, and full data residency controls.

## Repository Structure

```text
.
|-- index.html
|-- src
|   |-- main.js
|   |-- styles.css
|   |-- modules
|   |   |-- costing.js
|   |   |-- gcodeParser.js
|   |   |-- inventory.js
|   |   |-- scheduler.js
|   |   `-- storage.js
|   `-- ui
|       `-- render.js
|-- docs
|   |-- architecture.md
|   `-- product-requirements.md
`-- .github
    `-- workflows
        `-- pages.yml
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

## Architecture Requirement

The frontend target is React + Vite with a client-side file analysis engine, local processing first, and Progressive Web App compatibility. The backend may store user accounts, subscription status, inventory records, scheduling records, and extracted manufacturing metrics.

The backend should not require storage of raw STL, 3MF, or G-code files to provide core functionality. Future cloud processing must be opt-in, clearly disclosed, and explain exactly what files are transmitted and why.

## Future Backend Migration

The app is organized around small service modules:

- `storage.js` can be swapped for an API-backed repository.
- `gcodeParser.js` can move to a Web Worker while preserving the local-first processing model.
- `costing.js` can be connected to ERP pricing.
- `scheduler.js` can evolve into a multi-printer optimization service.
- `render.js` can later be replaced by React/Vite components without changing the domain logic.
