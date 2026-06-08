import { calculateProjectCosts } from "../modules/costing.js";
import {
  createInventoryItem,
  createInventorySpoolFromProduct,
  createProduct,
  findProductByBarcode,
  forecastInventory,
  inventoryWarnings,
  INVENTORY_STATUSES,
  MATERIALS,
  normalizeBarcode,
} from "../modules/inventory.js";
import { parseGcodeFile } from "../modules/gcodeParser.js";
import { detectPrinterId } from "../modules/printers.js";
import { buildSchedule } from "../modules/scheduler.js";
import { clearState, defaultState, exportState, importState } from "../modules/storage.js";

let activeTab = "jobs";
let pendingProductBarcode = "";
let scannerMessage = "";
let lastScannedBarcode = "";
let lastScannedAt = 0;
const SCAN_DEBOUNCE_MS = 1200;

export function renderApp(state, commit) {
  const costs = calculateProjectCosts(state.jobs, state.inventory);
  const warnings = inventoryWarnings(state.inventory, costs.requiredByMaterial);
  const schedule = buildSchedule(state.jobs, state.settings, state.printers);
  const forecast = forecastInventory(state.jobs, state.inventory, state.printers);
  const app = document.querySelector("#app");

  app.innerHTML = `
    <header class="topbar">
      <div>
        <p class="eyebrow">Artaic production</p>
        <h1>Print Planner</h1>
      </div>
      <div class="actions">
        <button class="secondary" data-action="export">Export</button>
        <label class="secondary file-action">
          Import <input data-action="import" type="file" accept="application/json" />
        </label>
        <button class="danger" data-action="clear">Clear</button>
      </div>
    </header>

    <main>
      <section class="metric-grid">
        ${metric("Queued jobs", state.jobs.length)}
        ${metric("Print queues", state.printers.length)}
        ${metric("Required material", `${sum(costs.requiredByMaterial).toFixed(0)}g`)}
        ${metric("Purchase forecast", purchaseMetric(forecast.purchaseNeeds))}
      </section>

      <section class="tabs">
        <div class="tab-list" role="tablist" aria-label="Dashboard sections">
          ${tabButton("jobs", "Jobs")}
          ${tabButton("inventory", "Inventory")}
          ${tabButton("schedule", "Schedule")}
          ${tabButton("materials", "Materials")}
        </div>

        <section class="tab-panel ${activeTab === "jobs" ? "active" : ""}" data-panel="jobs">
          <div class="panel">
            <div class="input-bar">
              <div>
                <h2>Print Queues</h2>
                <p>Uploaded files are assigned to printer queues from G-code metadata or filename rules.</p>
              </div>
              <label class="primary file-action">
                Upload G-code <input data-action="upload" type="file" accept=".bgcode,.gcode,.gco,.gc" multiple />
              </label>
            </div>
            ${renderJobQueues(state.jobs, state.printers, costs.jobCosts)}
          </div>
        </section>

        <section class="tab-panel ${activeTab === "inventory" ? "active" : ""}" data-panel="inventory">
          <div class="panel">
            <div class="input-stack">
              <div>
                <h2>Inventory</h2>
                <p>Add reserve stock or assign ready-to-consume spools to a printer tool.</p>
              </div>
              ${renderBarcodeScanner(state.products)}
              <div class="input-card">
                ${renderInventoryForm(state.printers)}
              </div>
            </div>
            ${renderInventory(state.inventory, state.printers, forecast)}
          </div>
        </section>

        <section class="tab-panel ${activeTab === "schedule" ? "active" : ""}" data-panel="schedule">
          <div class="panel">
            <div class="input-stack">
              <div>
                <h2>Schedule</h2>
                <p>Schedule windows apply to every active printer queue.</p>
              </div>
              ${renderSettings(state.settings)}
            </div>
            ${renderSchedule(schedule.jobs, state.printers, state.settings)}
          </div>
        </section>

        <section class="tab-panel ${activeTab === "materials" ? "active" : ""}" data-panel="materials">
          <div class="panel">
            <div class="input-bar">
              <div>
                <h2>Material Forecast</h2>
                <p>Queue demand is consumed from loaded spools first, then reserve stock.</p>
              </div>
            </div>
            ${renderWarnings(warnings)}
            ${renderPurchaseForecast(forecast.purchaseNeeds, forecast.purchaseSpools)}
            ${renderMaterials(costs.requiredByMaterial, costs.availableByMaterial, costs.costByMaterial)}
          </div>
        </section>
      </section>
    </main>
  `;

  bindEvents(app, state, commit);
}

function bindEvents(app, state, commit) {
  app.querySelectorAll("[data-tab]").forEach((button) => {
    button.addEventListener("click", () => {
      activeTab = button.dataset.tab;
      app.querySelectorAll("[data-tab]").forEach((tab) => {
        const selected = tab.dataset.tab === activeTab;
        tab.classList.toggle("active", selected);
        tab.setAttribute("aria-selected", selected ? "true" : "false");
      });
      app.querySelectorAll("[data-panel]").forEach((panel) => {
        panel.classList.toggle("active", panel.dataset.panel === activeTab);
      });
    });
  });

  app.querySelector("[data-action='upload']").addEventListener("change", async (event) => {
    const jobs = await Promise.all([...event.target.files].map(parseGcodeFile));
    commit({ ...state, jobs: [...state.jobs, ...jobs] });
  });

  app.querySelector("[data-action='add-inventory']").addEventListener("submit", (event) => {
    event.preventDefault();
    commit({ ...state, inventory: [...state.inventory, createInventoryItem(new FormData(event.target))] });
  });

  app.querySelector("[data-action='scan-barcode']")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const barcode = normalizeBarcode(new FormData(event.currentTarget).get("barcode"));
    if (!barcode) return;

    const now = Date.now();
    if (barcode === lastScannedBarcode && now - lastScannedAt < SCAN_DEBOUNCE_MS) {
      scannerMessage = "Duplicate scan ignored. Ready for the next spool.";
      commit(state);
      return;
    }

    lastScannedBarcode = barcode;
    lastScannedAt = now;

    const product = findProductByBarcode(state.products, barcode);
    activeTab = "inventory";

    if (!product) {
      pendingProductBarcode = barcode;
      scannerMessage = `Barcode ${barcode} is new. Add product details to receive this spool.`;
      commit(state);
      return;
    }

    const spool = createInventorySpoolFromProduct(product);
    pendingProductBarcode = "";
    scannerMessage = `Added ${product.brand} ${product.color} ${product.material} to inventory.`;
    commit({ ...state, inventory: [...state.inventory, spool] });
  });

  app.querySelector("[data-action='add-product-from-scan']")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const product = createProduct(formData);
    const spool = createInventorySpoolFromProduct(product, {
      storage_location: formData.get("storage_location"),
      notes: formData.get("spool_notes"),
    });

    pendingProductBarcode = "";
    scannerMessage = `Saved product and added ${product.brand} ${product.color} ${product.material} to inventory.`;
    commit({
      ...state,
      products: [...state.products, product],
      inventory: [...state.inventory, spool],
    });
  });

  app.querySelectorAll("[data-action='update-inventory']").forEach((form) => {
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const formData = new FormData(event.currentTarget);
      const id = event.currentTarget.dataset.id;
      commit({
        ...state,
        inventory: state.inventory.map((item) =>
          item.id === id ? updateInventoryItem(item, formData) : item
        ),
      });
    });
  });

  app.querySelectorAll("[data-action='assign-printer']").forEach((select) => {
    select.addEventListener("change", (event) => {
      commit({
        ...state,
        jobs: state.jobs.map((job) =>
          job.id === event.target.dataset.id ? { ...job, printerId: event.target.value } : job
        ),
      });
    });
  });

  app.addEventListener("click", (event) => {
    const button = event.target.closest("[data-action]");
    if (!button) return;
    const id = button.dataset.id;

    if (button.dataset.action === "delete-job") {
      commit({ ...state, jobs: state.jobs.filter((job) => job.id !== id) });
    }
    if (button.dataset.action === "delete-inventory") {
      commit({ ...state, inventory: state.inventory.filter((item) => item.id !== id) });
    }
    if (button.dataset.action === "export") {
      const link = document.createElement("a");
      link.href = exportState(state);
      link.download = "artaic-print-planner.json";
      link.click();
      URL.revokeObjectURL(link.href);
    }
    if (button.dataset.action === "clear" && confirm("Clear all local planner data?")) {
      clearState();
      commit(structuredClone(defaultState));
    }
  });

  app.querySelector("[data-action='import']").addEventListener("change", async (event) => {
    const file = event.target.files[0];
    if (file) commit(await importState(file));
  });

  app.querySelector("[data-action='settings']").addEventListener("change", (event) => {
    const form = new FormData(event.currentTarget);
    commit({
      ...state,
      settings: {
        dayStart: form.get("dayStart"),
        dayEnd: form.get("dayEnd"),
        changeoverStart: form.get("changeoverStart"),
        changeoverEnd: form.get("changeoverEnd"),
        deadline: form.get("deadline"),
        allowOvernight: form.get("allowOvernight") === "on",
      },
    });
  });
}

function metric(label, value) {
  return `<article class="metric"><span>${label}</span><strong>${value}</strong></article>`;
}

function tabButton(id, label) {
  const selected = activeTab === id;
  return `<button class="tab-button ${selected ? "active" : ""}" type="button" role="tab" data-tab="${id}" aria-selected="${
    selected ? "true" : "false"
  }">${label}</button>`;
}

function renderJobQueues(jobs, printers, jobCosts) {
  const queues = [
    ...printers.map((printer) => ({
      id: printer.id,
      name: printer.name,
      jobs: jobs.filter((job) => effectivePrinterId(job, printers) === printer.id),
    })),
    {
      id: "",
      name: "Unassigned",
      jobs: jobs.filter((job) => !effectivePrinterId(job, printers)),
    },
  ];

  return `<div class="queue-grid">${queues
    .map(
      (queue) => `
        <section class="queue">
          <div class="queue-title">
            <h3>${escapeHtml(queue.name)}</h3>
            <span>${queue.jobs.length}</span>
          </div>
          ${renderJobs(queue.jobs, printers, jobCosts)}
        </section>`
    )
    .join("")}</div>`;
}

function renderJobs(jobs, printers, jobCosts) {
  if (!jobs.length) return `<p class="empty small">No jobs in this queue.</p>`;
  const costMap = Object.fromEntries(jobCosts.map((job) => [job.jobId, job.cost]));
  return `<div class="table">${jobs
    .map(
      (job) => `
        <div class="row job-row">
          <div>
            <strong>${escapeHtml(job.name)}</strong>
            <span>${formatDuration(job.durationMinutes)} | ${materialsText(job.materials)}</span>
            <span>${jobDetails(job)}</span>
          </div>
          <div>${currency(costMap[job.id] || 0)}</div>
          ${renderPrinterSelect(job, printers)}
          <button class="icon" data-action="delete-job" data-id="${job.id}" title="Remove job">x</button>
        </div>`
    )
    .join("")}</div>`;
}

function renderPrinterSelect(job, printers) {
  const selectedPrinterId = effectivePrinterId(job, printers);
  return `
    <select class="queue-select" data-action="assign-printer" data-id="${job.id}" aria-label="Assign printer">
      <option value="" ${selectedPrinterId ? "" : "selected"}>Unassigned</option>
      ${printers
        .map(
          (printer) =>
            `<option value="${printer.id}" ${selectedPrinterId === printer.id ? "selected" : ""}>${escapeHtml(
              printer.name
            )}</option>`
        )
        .join("")}
    </select>`;
}

function effectivePrinterId(job, printers) {
  return job.printerId || detectPrinterId(job.metadata, `${job.fileName || ""} ${job.name || ""}`, printers);
}

function renderBarcodeScanner(products) {
  const productCount = products.length;
  return `
    <section class="scanner-card">
      <div class="scanner-header">
        <div>
          <h3>Barcode Intake</h3>
          <p>${productCount} saved product${productCount === 1 ? "" : "s"}</p>
        </div>
        <form class="scanner-form" data-action="scan-barcode">
          <input name="barcode" inputmode="numeric" autocomplete="off" placeholder="Scan barcode" autofocus />
          <button class="primary" type="submit">Scan</button>
        </form>
      </div>
      ${scannerMessage ? `<p class="scanner-message">${escapeHtml(scannerMessage)}</p>` : ""}
      ${pendingProductBarcode ? renderAddProductForm(pendingProductBarcode) : ""}
    </section>`;
}

function renderAddProductForm(barcode) {
  return `
    <form class="add-product-form" data-action="add-product-from-scan">
      <input name="barcode" type="hidden" value="${escapeHtml(barcode)}" />
      <label>Barcode <input value="${escapeHtml(barcode)}" disabled /></label>
      <label>Material
        <select name="material">${MATERIALS.map((material) => `<option>${material}</option>`).join("")}</select>
      </label>
      <label>Color <input name="color" placeholder="Color" required /></label>
      <label>Brand <input name="brand" placeholder="Brand" required /></label>
      <label>Spool Weight <input name="nominal_spool_weight" type="number" min="0" step="1" placeholder="1000" required /></label>
      <label>Cost <input name="default_cost" type="number" min="0" step="0.01" placeholder="24.99" required /></label>
      <label>Supplier <input name="supplier" placeholder="Supplier" /></label>
      <label>Storage Location <input name="storage_location" placeholder="Shelf / bin" /></label>
      <label class="wide">Product Notes <textarea name="notes" placeholder="Product notes"></textarea></label>
      <label class="wide">Spool Notes <textarea name="spool_notes" placeholder="Notes for this physical spool"></textarea></label>
      <button class="primary" type="submit">Save Product and Add Spool</button>
    </form>`;
}

function renderInventoryForm(printers) {
  return `
    <form class="inventory-form" data-action="add-inventory">
      <select name="material">${MATERIALS.map((material) => `<option>${material}</option>`).join("")}</select>
      <input name="color" placeholder="Color" />
      <input name="brand" placeholder="Brand" />
      <select name="status">${INVENTORY_STATUSES.map((status) => `<option value="${status}">${statusLabel(status)}</option>`).join("")}</select>
      <select name="printerId">
        <option value="">Reserve / unassigned</option>
        ${printers.map((printer) => `<option value="${printer.id}">${escapeHtml(printer.name)}</option>`).join("")}
      </select>
      <select name="toolhead">
        <option>T0</option>
        <option>T1</option>
      </select>
      <input name="spoolWeight" type="number" min="0" step="1" placeholder="Spool g" required />
      <input name="remainingWeight" type="number" min="0" step="1" placeholder="Remaining g" required />
      <input name="costPerSpool" type="number" min="0" step="0.01" placeholder="Cost" required />
      <input name="location" placeholder="Location" />
      <input name="notes" placeholder="Notes" />
      <button class="primary" type="submit">Add</button>
    </form>`;
}

function renderInventory(inventory, printers, forecast) {
  if (!inventory.length) return `<p class="empty">Add filament spools to estimate cost and shortages.</p>`;
  const remainingById = Object.fromEntries(forecast.remaining.map((item) => [item.id, item.remainingWeight]));
  const groups = [
    ...printers.map((printer) => ({
      name: `${printer.name} ready`,
      items: inventory.filter((item) => item.status === "ready" && item.printerId === printer.id),
    })),
    {
      name: "Reserve stock",
      items: inventory.filter((item) => item.status === "reserve" || !item.printerId),
    },
  ];

  return `<div class="inventory-groups">${groups
    .map(
      (group) => `
        <section class="inventory-group">
          <h3>${escapeHtml(group.name)}</h3>
          ${
            group.items.length
              ? `<div class="table">${group.items
                  .map((item) => renderInventoryItem(item, remainingById[item.id], printers))
                  .join("")}</div>`
              : `<p class="empty small">No spools.</p>`
          }
        </section>`
    )
    .join("")}</div>`;
}

function renderInventoryItem(item, forecastRemaining, printers) {
  const afterQueue = Number.isFinite(forecastRemaining) ? forecastRemaining : item.remainingWeight;
  return `
    <div class="row inventory-row">
      <div>
        <strong>${escapeHtml(item.brand)} ${escapeHtml(item.color)} ${escapeHtml(item.material)}</strong>
        <span>${statusLabel(item.status)} | ${escapeHtml(item.toolhead || "T0")} | ${escapeHtml(item.storage_location || item.location)}</span>
        ${item.barcode ? `<span>Barcode ${escapeHtml(item.barcode)}</span>` : ""}
        <span>${formatGramsForInventory(item.remainingWeight)} ready now | ${formatGramsForInventory(
          Math.max(0, afterQueue)
        )} after queue</span>
        ${item.notes ? `<span>${escapeHtml(item.notes)}</span>` : ""}
        <details class="edit-panel">
          <summary>Edit</summary>
          ${renderInventoryEditForm(item, printers)}
        </details>
      </div>
      <div>${currency(item.costPerGram * item.remainingWeight)}</div>
      <button class="icon" data-action="delete-inventory" data-id="${item.id}" title="Remove spool">x</button>
    </div>`;
}

function renderInventoryEditForm(item, printers) {
  return `
    <form class="inventory-edit-form" data-action="update-inventory" data-id="${item.id}">
      <select name="status">${INVENTORY_STATUSES.map((status) =>
        option(statusLabel(status), status, item.status)
      ).join("")}</select>
      <select name="printerId">
        <option value="" ${item.printerId ? "" : "selected"}>Reserve / unassigned</option>
        ${printers.map((printer) => option(printer.name, printer.id, item.printerId)).join("")}
      </select>
      <select name="toolhead">
        ${["T0", "T1"].map((toolhead) => option(toolhead, toolhead, item.toolhead || "T0")).join("")}
      </select>
      <input name="starting_weight" type="number" min="0" step="1" value="${item.starting_weight}" placeholder="Starting g" />
      <input name="remaining_weight" type="number" min="0" step="1" value="${item.remaining_weight}" placeholder="Remaining g" />
      <input name="cost" type="number" min="0" step="0.01" value="${item.cost}" placeholder="Cost" />
      <input name="storage_location" value="${escapeHtml(item.storage_location)}" placeholder="Storage location" />
      <textarea name="notes" placeholder="Notes">${escapeHtml(item.notes)}</textarea>
      <button class="primary" type="submit">Save</button>
    </form>`;
}

function renderSettings(settings) {
  return `
    <form class="settings" data-action="settings">
      <label>Print day start <input name="dayStart" type="time" value="${settings.dayStart}" /></label>
      <label>Print day end <input name="dayEnd" type="time" value="${settings.dayEnd}" /></label>
      <label>Changeover start <input name="changeoverStart" type="time" value="${settings.changeoverStart || settings.dayStart}" /></label>
      <label>Changeover end <input name="changeoverEnd" type="time" value="${settings.changeoverEnd || settings.dayEnd}" /></label>
      <label>Deadline <input name="deadline" type="date" value="${settings.deadline}" /></label>
      <label class="check"><input name="allowOvernight" type="checkbox" ${settings.allowOvernight ? "checked" : ""} /> Overnight</label>
    </form>`;
}

function renderSchedule(jobs, printers, settings = {}) {
  if (!jobs.length) return `<p class="empty">Schedule recommendations appear after jobs are uploaded.</p>`;
  const range = scheduleRange(jobs);

  return `
    <div class="gantt">
      <div class="changeover-note">
        Changeovers: ${settings.changeoverStart || settings.dayStart || "08:00"}-${settings.changeoverEnd || settings.dayEnd || "18:00"}
      </div>
      <div class="gantt-scale">
        <span>${dateTime(range.start)}</span>
        <span>${formatDuration(range.durationMinutes)}</span>
        <span>${dateTime(range.end)}</span>
      </div>
      ${printers
        .map((printer) => renderGanttLane(printer, jobs.filter((job) => job.printerId === printer.id), range))
        .join("")}
    </div>`;
}

function renderGanttLane(printer, jobs, range) {
  return `
    <section class="gantt-lane">
      <div class="gantt-lane-label">
        <h3>${escapeHtml(printer.name)}</h3>
        <span>${jobs.length} job${jobs.length === 1 ? "" : "s"}</span>
      </div>
      <div class="gantt-track">
        ${
          jobs.length
            ? jobs.map((job) => renderGanttBar(job, range)).join("")
            : `<p class="empty small">No scheduled jobs.</p>`
        }
      </div>
    </section>`;
}

function renderGanttBar(job, range) {
  const start = new Date(job.start);
  const end = new Date(job.end);
  const offset = Math.max(0, ((start - range.start) / (range.end - range.start)) * 100);
  const width = Math.max(2, ((end - start) / (range.end - range.start)) * 100);

  return `
    <article class="gantt-bar" style="left: ${offset}%; width: ${width}%;" title="${escapeHtml(job.name)}">
      <strong>${escapeHtml(job.name)}</strong>
      <span>${formatDuration(job.durationMinutes)} | ${timeOnly(job.start)}-${timeOnly(job.end)}</span>
    </article>`;
}

function scheduleRange(jobs) {
  const start = new Date(Math.min(...jobs.map((job) => new Date(job.start).getTime())));
  const end = new Date(Math.max(...jobs.map((job) => new Date(job.end).getTime())));
  const durationMinutes = Math.max(1, Math.round((end - start) / 60000));
  return { start, end, durationMinutes };
}

function renderWarnings(warnings) {
  if (!warnings.length) return `<p class="empty">No material warnings yet.</p>`;
  return `<div class="warnings">${warnings.map((warning) => `<p>${escapeHtml(warning.message)}</p>`).join("")}</div>`;
}

function renderPurchaseForecast(purchaseNeeds, purchaseSpools) {
  const entries = Object.entries(purchaseNeeds);
  if (!entries.length) return `<p class="empty">Loaded and reserve filament cover the current queues.</p>`;
  return `<div class="warnings">${entries
    .map(
      ([material, grams]) =>
        `<p>${escapeHtml(material)}: buy ${purchaseSpools[material]} spool(s), ${Math.ceil(grams)}g forecast short</p>`
    )
    .join("")}</div>`;
}

function renderMaterials(required, available, costs) {
  const materials = [...new Set([...Object.keys(required), ...Object.keys(available)])];
  if (!materials.length) return "";
  return `<div class="table compact">${materials
    .map(
      (material) => `
        <div class="row">
          <div>
            <strong>${escapeHtml(material)}</strong>
            <span>Need ${(required[material] || 0).toFixed(0)}g | Have ${(available[material] || 0).toFixed(0)}g</span>
          </div>
          <div>${currency(costs[material] || 0)}</div>
        </div>`
    )
    .join("")}</div>`;
}

function sum(values) {
  return Object.values(values).reduce((total, value) => total + value, 0);
}

function purchaseMetric(purchaseNeeds) {
  const grams = sum(purchaseNeeds);
  return grams > 0 ? `${Math.ceil(grams)}g` : "Covered";
}

function statusLabel(status) {
  return status === "ready" ? "Ready to consume" : "Reserve";
}

function updateInventoryItem(item, formData) {
  const spoolWeight = Number(formData.get("starting_weight")) || 0;
  const remainingWeight = Number(formData.get("remaining_weight")) || 0;
  const costPerSpool = Number(formData.get("cost")) || 0;
  const printerId = String(formData.get("printerId") || "");
  const status = printerId ? String(formData.get("status") || "ready") : "reserve";
  const storageLocation = String(formData.get("storage_location") || "").trim();

  return {
    ...item,
    starting_weight: spoolWeight,
    spoolWeight,
    remaining_weight: remainingWeight,
    remainingWeight,
    cost: costPerSpool,
    costPerSpool,
    costPerGram: spoolWeight > 0 ? costPerSpool / spoolWeight : 0,
    storage_location: storageLocation,
    location: storageLocation,
    status,
    printerId,
    toolhead: String(formData.get("toolhead") || "T0"),
    notes: String(formData.get("notes") || "").trim(),
    updatedAt: new Date().toISOString(),
  };
}

function option(label, value, selectedValue) {
  return `<option value="${escapeHtml(value)}" ${value === selectedValue ? "selected" : ""}>${escapeHtml(label)}</option>`;
}

function materialsText(materials) {
  return Object.entries(materials)
    .map(([material, grams]) => `${material} ${Math.round(grams)}g`)
    .join(", ");
}

function jobDetails(job) {
  const model = job.metadata?.printer_model ? `Model ${job.metadata.printer_model}` : "";
  const tools = Array.isArray(job.toolheads) && job.toolheads.length ? `Tools ${job.toolheads.join(", ")}` : "";
  return [model, tools].filter(Boolean).map(escapeHtml).join(" | ");
}

function formatDuration(minutes) {
  if (!minutes) return "Duration unknown";
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return hours ? `${hours}h ${mins}m` : `${mins}m`;
}

function formatGramsForInventory(grams) {
  const value = Number(grams) || 0;
  return `${Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1)}g`;
}

function currency(value) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value || 0);
}

function dateTime(value) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function timeOnly(value) {
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
