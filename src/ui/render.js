import { calculateJobCost, calculateProjectCosts } from "../modules/costing.js";
import { parseGcodeFile } from "../modules/gcodeParser.js";
import {
  createInventoryItem,
  inventoryWarnings,
  MATERIALS,
} from "../modules/inventory.js";
import { buildSchedule } from "../modules/scheduler.js";
import { clearState, exportState, importState } from "../modules/storage.js";

const app = document.querySelector("#app");

export function renderApp(state, commit) {
  const costs = calculateProjectCosts(state.jobs, state.inventory);
  const schedule = buildSchedule(state.jobs, state.settings);
  const page = currentPage();
  const warnings = [
    ...inventoryWarnings(state.inventory, costs.requiredByMaterial),
    ...(schedule.deadlineRisk
      ? [{ type: "shortage", message: `Schedule exceeds ${formatDate(schedule.deadline)}` }]
      : []),
  ];

  app.innerHTML = `
    <header class="topbar">
      <div>
        <p class="eyebrow">Manufacturing Estimator</p>
        <h1>Your files stay with you.</h1>
        <p class="topbar-copy">Local-first 3D print planning that stores manufacturing metrics, not proprietary geometry.</p>
      </div>
      <nav class="page-nav" aria-label="Primary">
        ${navLink("dashboard", "Dashboard", page)}
        ${navLink("overview", "Overview", page)}
        ${navLink("pricing", "Pricing", page)}
        ${navLink("privacy", "Privacy", page)}
        ${navLink("faq", "FAQ", page)}
        ${navLink("onboarding", "Onboarding", page)}
      </nav>
    </header>

    <main class="layout">
      ${renderPage(page, state, costs, schedule, warnings)}
    </main>
  `;

  bindEvents(state, commit);
}

function bindEvents(state, commit) {
  app.querySelector("[data-action='upload']")?.addEventListener("change", async (event) => {
    const files = [...event.target.files];
    const parsedJobs = await Promise.all(files.map(parseGcodeFile));
    state.jobs = [...state.jobs, ...parsedJobs];
    commit();
  });

  app.querySelector("[data-action='inventory-form']")?.addEventListener("submit", (event) => {
    event.preventDefault();
    state.inventory = [...state.inventory, createInventoryItem(new FormData(event.currentTarget))];
    commit();
  });

  app.querySelector("[data-action='settings-form']")?.addEventListener("input", (event) => {
    const form = new FormData(event.currentTarget);
    state.settings = {
      printerCount: Number(form.get("printerCount")),
      dayStart: form.get("dayStart"),
      dayEnd: form.get("dayEnd"),
      deadline: form.get("deadline"),
      allowOvernight: Boolean(form.get("allowOvernight")),
    };
    commit();
  });

  app.querySelectorAll("[data-remove-job]").forEach((button) => {
    button.addEventListener("click", () => {
      state.jobs = state.jobs.filter((job) => job.id !== button.dataset.removeJob);
      commit();
    });
  });

  app.querySelectorAll("[data-remove-inventory]").forEach((button) => {
    button.addEventListener("click", () => {
      state.inventory = state.inventory.filter((item) => item.id !== button.dataset.removeInventory);
      commit();
    });
  });

  app.querySelector("[data-action='export']")?.addEventListener("click", () => {
    const link = document.createElement("a");
    link.href = exportState(state);
    link.download = `artaic-print-planner-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(link.href);
  });

  app.querySelector("[data-action='import']")?.addEventListener("change", async (event) => {
    const file = event.target.files[0];
    if (!file) return;
    const imported = await importState(file);
    Object.assign(state, imported);
    commit();
  });

  app.querySelector("[data-action='clear']")?.addEventListener("click", () => {
    if (!confirm("Clear local planner data?")) return;
    clearState();
    state.jobs = [];
    state.inventory = [];
    commit();
  });
}

function currentPage() {
  const page = window.location.hash.replace("#", "") || "dashboard";
  return ["dashboard", "overview", "pricing", "privacy", "faq", "onboarding"].includes(page)
    ? page
    : "dashboard";
}

function navLink(page, label, activePage) {
  return `<a class="${page === activePage ? "active" : ""}" href="#${page}">${label}</a>`;
}

function renderPage(page, state, costs, schedule, warnings) {
  const pages = {
    dashboard: () => renderDashboard(state, costs, schedule, warnings),
    overview: renderOverview,
    pricing: renderPricing,
    privacy: renderPrivacy,
    faq: renderFaq,
    onboarding: renderOnboarding,
  };
  return pages[page]();
}

function renderDashboard(state, costs, schedule, warnings) {
  return `
    <section class="page-intro">
      <div>
        <p class="eyebrow">Production console</p>
        <h2>Plan prints from extracted metrics.</h2>
        <p>Upload local G-code, maintain spool inventory, and sequence production without storing raw manufacturing files.</p>
      </div>
      <div class="topbar-actions dashboard-actions">
        <button class="ghost" data-action="export">Export</button>
        <label class="button ghost">
          Import
          <input class="visually-hidden" type="file" accept="application/json" data-action="import" />
        </label>
        <button class="danger" data-action="clear">Clear</button>
      </div>
    </section>

    <section class="summary-grid">
      ${summaryTile("Jobs", state.jobs.length)}
      ${summaryTile("Print Time", formatDuration(sum(state.jobs.map((job) => job.durationMinutes))))}
      ${summaryTile("Project Cost", money(costs.totalCost))}
      ${summaryTile("Inventory Value", money(costs.remainingInventoryValue))}
      ${summaryTile("Utilization", percent(schedule.utilization))}
      ${summaryTile("Complete", schedule.completionDate ? formatDateTime(schedule.completionDate) : "-")}
    </section>

    <section class="workspace">
      <div class="panel upload-panel">
        <div class="panel-header">
          <h2>Local File Analysis</h2>
          <span>${state.jobs.length} active</span>
        </div>
        <p class="privacy-note">Customer file processing remains local. Raw G-code is read in your browser and only extracted job metrics are saved.</p>
        <label class="dropzone">
          <input type="file" multiple accept=".gcode,.gco,.gc" data-action="upload" />
          <strong>Select G-code files</strong>
          <span>.gcode, .gco, .gc</span>
        </label>
        <div class="job-list">
          ${state.jobs.map((job) => jobRow(job, state.inventory)).join("") || emptyState("No uploaded jobs")}
        </div>
      </div>

      <div class="panel">
        <div class="panel-header">
          <h2>Inventory</h2>
          <span>${state.inventory.length} spools</span>
        </div>
        ${inventoryForm()}
        <div class="inventory-list">
          ${state.inventory.map(inventoryRow).join("") || emptyState("No inventory records")}
        </div>
      </div>
    </section>

    <section class="workspace lower">
      <div class="panel">
        <div class="panel-header">
          <h2>Planning Settings</h2>
          <span>${state.settings.printerCount} printers</span>
        </div>
        ${settingsForm(state.settings)}
        <div class="alerts">
          ${warnings.map((warning) => `<div class="alert ${warning.type}">${warning.message}</div>`).join("") || emptyState("No inventory warnings")}
        </div>
      </div>

      <div class="panel timeline-panel">
        <div class="panel-header">
          <h2>Recommended Sequence</h2>
          <span>${percent(schedule.utilization)} utilization</span>
        </div>
        <div class="timeline">
          ${schedule.scheduledJobs.map(timelineRow).join("") || emptyState("No scheduled jobs")}
        </div>
      </div>
    </section>

    <section class="panel full">
      <div class="panel-header">
        <h2>Cost Breakdown</h2>
        <span>${money(costs.totalCost)} total</span>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Material</th>
              <th>Required</th>
              <th>Available</th>
              <th>Estimated Cost</th>
            </tr>
          </thead>
          <tbody>
            ${Object.keys({ ...costs.requiredByMaterial, ...costs.availableByMaterial })
              .map((material) => materialCostRow(material, costs))
              .join("") || `<tr><td colspan="4">No material requirements</td></tr>`}
          </tbody>
        </table>
      </div>
    </section>
  `;
}

function renderOverview() {
  return `
    <section class="hero-band">
      <div>
        <p class="eyebrow">Privacy-first production planning</p>
        <h2>Your geometry files stay with you. We only need the manufacturing metrics.</h2>
        <p>Analyze manufacturing files locally whenever technically feasible, then use extracted metrics for estimating, scheduling, inventory, and reporting.</p>
      </div>
      <div class="promise-stack" aria-label="Privacy commitments">
        <span>Your manufacturing files are analyzed locally.</span>
        <span>We do not use customer files for AI training.</span>
        <span>We store manufacturing metrics, not proprietary geometry.</span>
      </div>
    </section>

    <section class="trust-grid" aria-label="Privacy requirements">
      ${trustCard("Local Processing First", "G-code analysis runs in the browser today. STL and 3MF analysis are planned around the same local-first requirement whenever technically feasible.")}
      ${trustCard("Metrics, Not Files", "The app stores print time, filament, material, cost, scheduling, inventory, and production metrics rather than raw design files.")}
      ${trustCard("No Data Monetization", "We do not sell customer data, and customer files are not used for AI training. Your subscription funds the software.")}
    </section>
  `;
}

function renderPricing() {
  return `
    <section class="page-intro">
      <div>
        <p class="eyebrow">Pricing</p>
        <h2>Plans funded by subscriptions, not customer data.</h2>
        <p>Every tier keeps customer file control at the center of the product architecture.</p>
      </div>
    </section>
    <section class="pricing-grid">
      ${planCard("Starter", "$9", [
        "Local G-code analysis",
        "Basic inventory management",
        "Basic scheduling",
        "Customer file processing remains local",
      ])}
      ${planCard("Professional", "$29", [
        "Local STL, 3MF, and G-code analysis",
        "Cloud synchronization of extracted metrics",
        "Team collaboration",
        "Advanced scheduling",
        "Inventory forecasting",
      ])}
      ${planCard("Business", "$99", [
        "Shared company workspaces",
        "Audit logging",
        "Advanced reporting",
        "Role-based permissions",
        "Cloud synchronization of extracted metrics only",
      ])}
      ${planCard("Enterprise", "Custom", [
        "Self-hosted deployment",
        "Customer-controlled infrastructure",
        "On-premise processing",
        "SSO integration",
        "Customer-owned databases",
        "Full data residency controls",
      ])}
    </section>
  `;
}

function renderPrivacy() {
  return `
    <section class="page-intro">
      <div>
        <p class="eyebrow">Privacy Policy</p>
        <h2>Manufacturing metrics are the data boundary.</h2>
        <p>Raw geometry and customer design files are not required for core application functionality.</p>
      </div>
    </section>
    <section class="workspace lower">
      <div class="panel">
        <div class="panel-header">
          <h2>Default Boundary</h2>
          <span>Files stay local</span>
        </div>
        <ul class="policy-list">
          <li>Raw geometry files are not permanently stored on company servers by default.</li>
          <li>Raw geometry files are not sold, shared, licensed, distributed, or used for AI training.</li>
          <li>Company employees cannot access customer files except through explicit customer-authorized support workflows.</li>
          <li>Future cloud processing must be opt-in and disclose exactly what files are transmitted and why.</li>
        </ul>
      </div>
      <div class="panel">
        <div class="panel-header">
          <h2>Stored Metrics</h2>
          <span>Planning data only</span>
        </div>
        <ul class="policy-list">
          <li>Print time, filament consumption, material type, and material cost.</li>
          <li>Project names, scheduling records, inventory records, and production statistics.</li>
          <li>No STL geometry, CAD models, mesh data, proprietary part geometry, or raw manufacturing files by default.</li>
        </ul>
      </div>
    </section>
  `;
}

function renderFaq() {
  return `
    <section class="page-intro">
      <div>
        <p class="eyebrow">FAQ</p>
        <h2>Clear answers for file control.</h2>
        <p>The core workflow is designed around local analysis and extracted manufacturing metrics.</p>
      </div>
    </section>
    <section class="panel full">
      <div class="faq-list">
        ${faqItem("Do my manufacturing files leave my browser?", "Core G-code analysis runs locally in this version. Future cloud processing must be opt-in and clearly disclosed.")}
        ${faqItem("What data can be stored?", "Print time, filament use, material type, material cost, project names, scheduling data, inventory data, and production statistics.")}
        ${faqItem("Are customer files used for AI training?", "No. Customer files are not used for AI training and customer data is not sold.")}
        ${faqItem("What happens if cloud processing is added later?", "It must be opt-in, explain exactly what files are transmitted, and disclose why transmission is required.")}
      </div>
    </section>
  `;
}

function renderOnboarding() {
  return `
    <section class="onboarding-band">
      <div>
        <p class="eyebrow">Account onboarding</p>
        <h2>Start with local analysis.</h2>
        <p>Connect inventory and scheduling around extracted manufacturing metrics. Keep proprietary geometry under your control.</p>
      </div>
      <ol>
        <li>Select local manufacturing files.</li>
        <li>Review extracted metrics before saving planning data.</li>
        <li>Sync metrics only when your subscription and workspace settings allow it.</li>
      </ol>
    </section>
  `;
}

function summaryTile(label, value) {
  return `
    <article class="summary-tile">
      <span>${label}</span>
      <strong>${value}</strong>
    </article>
  `;
}

function trustCard(title, text) {
  return `
    <article class="trust-card">
      <strong>${title}</strong>
      <span>${text}</span>
    </article>
  `;
}

function planCard(name, price, features) {
  return `
    <article class="plan-card">
      <div>
        <strong>${name}</strong>
        <span>${price}${price.startsWith("$") ? "/month" : ""}</span>
      </div>
      <ul>
        ${features.map((feature) => `<li>${feature}</li>`).join("")}
      </ul>
    </article>
  `;
}

function faqItem(question, answer) {
  return `
    <details class="faq-item">
      <summary>${question}</summary>
      <p>${answer}</p>
    </details>
  `;
}

function jobRow(job, inventory) {
  const cost = calculateJobCost(job, inventory);
  const materials = Object.entries(job.materials)
    .map(([material, grams]) => `${material} ${formatGrams(grams)}`)
    .join(", ");
  return `
    <article class="job-row">
      <div>
        <strong>${escapeHtml(job.fileName)}</strong>
        <span>${formatDuration(job.durationMinutes)} | ${materials || "Unknown material"} | ${money(cost)}</span>
        <span>Time source: ${escapeHtml(job.timeSource || "legacy parse - reupload to refresh")}</span>
        <span>Complete from now: ${formatDateTime(job.estimatedCompletion)}</span>
        ${toolSummary(job)}
        ${metadataDiagnostics(job)}
        ${job.parserNotes.length ? `<small>${job.parserNotes.join(" ")}</small>` : ""}
      </div>
      <button class="icon-button" title="Remove job" data-remove-job="${job.id}">x</button>
    </article>
  `;
}

function inventoryForm() {
  return `
    <form class="inventory-form" data-action="inventory-form">
      <label>Material
        <select name="material">${MATERIALS.map((material) => `<option>${material}</option>`).join("")}</select>
      </label>
      <label>Color<input name="color" placeholder="Bone white" /></label>
      <label>Brand<input name="brand" placeholder="Artaic stock" /></label>
      <label>Spool g<input name="spoolWeight" type="number" value="1000" min="0" step="1" /></label>
      <label>Remaining g<input name="remainingWeight" type="number" value="1000" min="0" step="1" /></label>
      <label>Cost<input name="costPerSpool" type="number" value="24" min="0" step="0.01" /></label>
      <label>Location<input name="location" placeholder="Rack A2" /></label>
      <button type="submit">Add Spool</button>
    </form>
  `;
}

function inventoryRow(item) {
  return `
    <article class="inventory-row">
      <div class="swatch" style="background:${cssColor(item.color)}"></div>
      <div>
        <strong>${item.material} ${escapeHtml(item.color)}</strong>
        <span>${escapeHtml(item.brand)} | ${formatGrams(item.remainingWeight)} left | ${money(item.costPerGram)}/g</span>
        <small>${escapeHtml(item.location || "Unassigned")}</small>
      </div>
      <button class="icon-button" title="Remove spool" data-remove-inventory="${item.id}">x</button>
    </article>
  `;
}

function settingsForm(settings) {
  return `
    <form class="settings-grid" data-action="settings-form">
      <label>Printers<input name="printerCount" type="number" min="1" max="24" value="${settings.printerCount}" /></label>
      <label>Start<input name="dayStart" type="time" value="${settings.dayStart}" /></label>
      <label>End<input name="dayEnd" type="time" value="${settings.dayEnd}" /></label>
      <label>Deadline<input name="deadline" type="date" value="${settings.deadline}" /></label>
      <label class="toggle"><input name="allowOvernight" type="checkbox" ${settings.allowOvernight ? "checked" : ""} /> Overnight</label>
    </form>
  `;
}

function timelineRow(job) {
  return `
    <article class="timeline-row ${job.overnight ? "overnight" : ""}">
      <div>
        <strong>${escapeHtml(job.fileName)}</strong>
        <span>${job.printer} | ${job.material} | ${formatDuration(job.durationMinutes)}</span>
      </div>
      <time>${formatDateTime(job.start)} to ${formatDateTime(job.end)}</time>
    </article>
  `;
}

function toolSummary(job) {
  const tools = job.toolUsage
    .filter((usage) => usage.grams > 0)
    .map((usage) => `${usage.tool} ${usage.material} ${formatGrams(usage.grams)}`)
    .join(", ");
  return tools ? `<small>${tools}</small>` : "";
}

function metadataDiagnostics(job) {
  const diagnostics = job.metadataDiagnostics;
  if (!diagnostics) return "";

  const slicerHints = diagnostics.slicerHints || [];
  const timeLikeLines = diagnostics.timeLikeLines || [];
  if (!slicerHints.length && !timeLikeLines.length) return "";

  return `
    <details class="metadata-details">
      <summary>Metadata diagnostics</summary>
      ${slicerHints.length ? `<small>Slicer hints: ${slicerHints.map(escapeHtml).join(" | ")}</small>` : ""}
      ${timeLikeLines.length ? `<small>Time-like lines: ${timeLikeLines.map(escapeHtml).join(" | ")}</small>` : ""}
    </details>
  `;
}

function materialCostRow(material, costs) {
  return `
    <tr>
      <td>${material}</td>
      <td>${formatGrams(costs.requiredByMaterial[material] || 0)}</td>
      <td>${formatGrams(costs.availableByMaterial[material] || 0)}</td>
      <td>${money(costs.costByMaterial[material] || 0)}</td>
    </tr>
  `;
}

function emptyState(text) {
  return `<p class="empty">${text}</p>`;
}

function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

function formatDuration(minutes) {
  const safeMinutes = Math.max(0, Math.round(minutes || 0));
  const hours = Math.floor(safeMinutes / 60);
  const mins = safeMinutes % 60;
  return hours ? `${hours}h ${mins}m` : `${mins}m`;
}

function formatGrams(grams) {
  return `${Math.round(grams || 0)}g`;
}

function money(value) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: value < 1 ? 3 : 2,
  }).format(value || 0);
}

function percent(value) {
  return `${Math.round((value || 0) * 100)}%`;
}

function formatDateTime(value) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatDate(value) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(value));
}

function cssColor(value) {
  const color = String(value || "").toLowerCase();
  const named = {
    black: "#151515",
    white: "#f5f5f0",
    red: "#b72e35",
    blue: "#2769a8",
    green: "#3f7d4a",
    yellow: "#e4b73a",
    orange: "#d9732f",
    gray: "#8b9198",
    grey: "#8b9198",
    clear: "linear-gradient(135deg, #f7f7f7, #cfe5ff)",
  };
  return named[color] || "#9aa3ad";
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
