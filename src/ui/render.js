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
import {
  availabilityWindowsForDate,
  buildScheduleCalendar,
  completeElapsedPrintingJobs,
  commitQueuedJobsToSchedule,
  SCHEDULE_VIEWS,
  unscheduleJob,
  updateScheduledJobStatus,
} from "../modules/scheduler.js";
import { clearState, defaultState, exportState, importState } from "../modules/storage.js";
import {
  calculateCapacityHeatmap,
  calculatePrinterUtilization,
  diagnoseBottlenecks,
  generateRecommendedActions,
  getPrinterStatus,
  groupLeadTimeRisks,
  PRODUCTION_STATUSES,
  urgencyScore,
} from "../modules/productionAnalytics.js";

let activeTab = "jobs";
let queueSort = "urgency";
let pendingProductBarcode = "";
let scannerMessage = "";
let lastScannedBarcode = "";
let lastScannedAt = 0;
let scheduleMessage = "";
let scheduleZoom = 1;
let printCompletionTimer = null;
const SCAN_DEBOUNCE_MS = 1200;

export function renderApp(state, commit) {
  const completedState = completeElapsedPrintingJobs(state);
  if (completedState !== state) {
    commit(completedState);
    return;
  }

  const costs = calculateProjectCosts(state.jobs, state.inventory);
  const warnings = inventoryWarnings(state.inventory, costs.requiredByMaterial);
  const schedule = buildScheduleCalendar(state);
  const forecast = forecastInventory(state.jobs, state.inventory, state.printers);
  const targetWeek = state.settings.scheduleWeek || schedule.visibleStart;
  const printerStatuses = state.printers.map((printer) =>
    getPrinterStatus(
      printer,
      state.jobs,
      state.scheduledJobs,
      state.scheduleBlocks,
      targetWeek,
      state.printerAvailability,
      state.inventory
    )
  );
  const weekCapacity = summarizeWeeklyCapacity(state, targetWeek);
  const leadTimeRisks = groupLeadTimeRisks(
    state.jobs,
    state.scheduledJobs,
    state.inventory,
    state.printerAvailability,
    state.printers
  );
  const bottlenecks = diagnoseBottlenecks(
    state.printers,
    state.jobs,
    state.scheduledJobs,
    state.inventory,
    state.scheduleBlocks,
    targetWeek,
    state.printerAvailability
  );
  const recommendedActions = generateRecommendedActions(
    state.printers,
    state.jobs,
    state.scheduledJobs,
    state.inventory,
    targetWeek,
    state.scheduleBlocks,
    state.printerAvailability
  );
  const riskByJob = Object.fromEntries(
    Object.values(leadTimeRisks)
      .flat()
      .map((risk) => [risk.job.id, risk])
  );
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
      ${renderCapacityOverview(weekCapacity, leadTimeRisks)}
      ${renderPrinterStatusPanel(printerStatuses)}
      <section class="dashboard-grid">
        ${renderLeadTimeRiskPanel(leadTimeRisks)}
        ${renderBottleneckDiagnosis(bottlenecks)}
        ${renderRecommendedActions(recommendedActions)}
      </section>

      <section class="tabs">
        <div class="tab-list" role="tablist" aria-label="Dashboard sections">
          ${tabButton("jobs", "Jobs")}
          ${tabButton("inventory", "Inventory")}
          ${tabButton("schedule", "Schedule")}
          ${tabButton("materials", "Materials")}
          ${tabButton("printers", "Printers")}
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
            ${renderQueueControls()}
            ${renderJobQueues(state, costs.jobCosts, riskByJob)}
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
                <p>Commit queued jobs into planned printer calendar slots without starting physical prints.</p>
              </div>
              ${renderScheduleControls(state, schedule)}
            </div>
            ${renderSchedule(schedule, state)}
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

        <section class="tab-panel ${activeTab === "printers" ? "active" : ""}" data-panel="printers">
          <div class="panel">
            <div class="input-stack">
              <div>
                <h2>Printers</h2>
                <p>Add production machines, remove retired printers, and manage G-code filename/model matching.</p>
              </div>
              <div class="input-card">
                ${renderAddPrinterForm()}
              </div>
            </div>
            ${renderPrinters(state)}
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

  app.querySelector("[data-action='add-printer']")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const printer = createPrinterFromForm(new FormData(event.currentTarget), state.printers);
    activeTab = "printers";
    commit({ ...state, printers: [...state.printers, printer] });
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

  app.querySelector("[data-action='queue-sort']")?.addEventListener("change", (event) => {
    queueSort = event.target.value;
    commit(state);
  });

  app.querySelectorAll("[data-action='update-job-priority']").forEach((select) => {
    select.addEventListener("change", (event) => {
      commit({
        ...state,
        jobs: state.jobs.map((job) =>
          job.id === event.target.dataset.id ? { ...job, customerPriority: event.target.value } : job
        ),
      });
    });
  });

  app.querySelector("[data-action='schedule-controls']")?.addEventListener("change", (event) => {
    const form = new FormData(event.currentTarget);
    commit({
      ...state,
      settings: {
        ...state.settings,
        scheduleMonth: form.get("scheduleMonth"),
        scheduleWeek: form.get("scheduleWeek"),
        scheduleView: form.get("scheduleView"),
        printerFilter: form.get("printerFilter"),
        materialFilter: form.get("materialFilter"),
        queueFilter: form.get("queueFilter"),
      },
    });
  });

  app.querySelector("[data-action='commit-schedule']")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const selectedJobs = [...app.querySelectorAll("[data-schedule-job]:checked")].map((input) => input.value);
    const result = commitQueuedJobsToSchedule(state, {
      jobIds: selectedJobs,
      targetWeek: form.get("targetWeek"),
      printerId: form.get("printerId"),
      preferredStart: form.get("preferredStart"),
      priority: form.get("priority"),
    });
    scheduleMessage = result.warnings.length ? result.warnings.join(" ") : `${selectedJobs.length} job(s) scheduled.`;
    activeTab = "schedule";
    commit(result.state);
  });

  app.querySelector("[data-action='changeover-rules']")?.addEventListener("change", (event) => {
    const form = new FormData(event.currentTarget);
    commit({
      ...state,
      changeoverRules: {
        ...state.changeoverRules,
        default_changeover_minutes: Number(form.get("default_changeover_minutes")) || 30,
        material_changeover_minutes: Number(form.get("material_changeover_minutes")) || 45,
        color_changeover_minutes: Number(form.get("color_changeover_minutes")) || 30,
        removal_required_minutes: Number(form.get("removal_required_minutes")) || 15,
        setup_required_minutes: Number(form.get("setup_required_minutes")) || 15,
        auto_complete_after_start: form.get("auto_complete_after_start") === "on",
      },
    });
  });

  app.querySelector("[data-action='servicer-availability']")?.addEventListener("change", (event) => {
    const form = new FormData(event.currentTarget);
    commit({
      ...state,
      servicerAvailability: [0, 1, 2, 3, 4, 5, 6].map((day) => {
        const window = state.servicerAvailability.find((item) => Number(item.day_of_week) === day) || {};
        return {
          id: window.id || `servicer-${day}`,
          day_of_week: day,
          start_time: form.get(`start-${day}`) || window.start_time || "08:00",
          end_time: form.get(`end-${day}`) || window.end_time || "17:00",
          is_available: form.get(`available-${day}`) === "on",
          notes: window.notes || "",
        };
      }),
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
    if (button.dataset.action === "delete-printer") {
      activeTab = "printers";
      commit(removePrinterFromState(state, id));
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
    if (button.dataset.action === "start-scheduled-job") {
      commit(updateScheduledJobStatus(state, id, "printing"));
    }
    if (button.dataset.action === "unschedule-job") {
      commit(unscheduleJob(state, id));
    }
  });

  app.querySelector("[data-action='import']").addEventListener("change", async (event) => {
    const file = event.target.files[0];
    if (file) commit(await importState(file));
  });

  app.querySelector("[data-action='settings']")?.addEventListener("change", (event) => {
    const form = new FormData(event.currentTarget);
    commit({
      ...state,
      settings: {
        ...state.settings,
        dayStart: form.get("dayStart"),
        dayEnd: form.get("dayEnd"),
        changeoverStart: form.get("changeoverStart"),
        changeoverEnd: form.get("changeoverEnd"),
        deadline: form.get("deadline"),
        allowOvernight: form.get("allowOvernight") === "on",
      },
    });
  });

  app.onwheel = (event) => {
    const gantt = event.target.closest?.(".month-gantt");
    if (!gantt) return;
    event.preventDefault();
    event.stopPropagation();
    const scrollRatio = gantt.scrollWidth ? gantt.scrollLeft / gantt.scrollWidth : 0;
    const direction = event.deltaY < 0 ? 0.18 : -0.18;
    scheduleZoom = Math.min(4, Math.max(0.7, scheduleZoom + direction));
    applyScheduleZoom(gantt);
    gantt.scrollLeft = scrollRatio * gantt.scrollWidth;
  };

  schedulePrintCompletionTimer(state, commit);
}

function metric(label, value) {
  return `<article class="metric"><span>${label}</span><strong>${value}</strong></article>`;
}

function renderCapacityOverview(capacity, risks) {
  const riskCount = risks["at-risk"].length;
  const lateCount = risks.late.length;
  const capacityClass = capacity.overloaded ? "danger" : capacity.utilization < 35 ? "warning" : "good";
  return `
    <section class="capacity-overview ${capacityClass}">
      <div class="capacity-hero">
        <span>Weekly utilization</span>
        <strong>${capacity.utilization.toFixed(1)}%</strong>
        <p>${capacity.overloaded ? "Capacity is overloaded this week." : capacity.utilization < 35 ? "Available machine time is underused." : "Capacity is balanced for the selected week."}</p>
      </div>
      <div class="capacity-metrics">
        ${metric("Scheduled machine hours", capacity.scheduledHours.toFixed(1))}
        ${metric("Available machine hours", capacity.availableHours.toFixed(0))}
        ${metric("Idle machine hours", capacity.idleHours.toFixed(1))}
        ${metric("Changeover hours", capacity.changeoverHours.toFixed(1))}
        ${metric("Jobs at risk", riskCount)}
        ${metric("Late jobs", lateCount)}
      </div>
    </section>`;
}

function renderPrinterStatusPanel(printerStatuses) {
  return `
    <section class="panel printer-status-panel">
      <div class="panel-title">
        <div>
          <h2>Printer Status</h2>
          <p>What each machine is doing now and how much weekly capacity remains.</p>
        </div>
      </div>
      <div class="printer-status-table">
        <div class="status-header">Printer</div>
        <div class="status-header">Status</div>
        <div class="status-header">Current job</div>
        <div class="status-header">Utilization</div>
        <div class="status-header">Scheduled</div>
        <div class="status-header">Idle</div>
        <div class="status-header">Next job</div>
        <div class="status-header">Risk</div>
        ${printerStatuses.map(renderPrinterStatusRow).join("")}
      </div>
    </section>`;
}

function renderPrinterStatusRow(status) {
  return `
    <div class="status-cell"><strong>${escapeHtml(status.printer.name)}</strong></div>
    <div class="status-cell"><span class="risk-pill ${riskClass(status.status)}">${escapeHtml(status.status)}</span></div>
    <div class="status-cell">${escapeHtml(status.currentJobName || "No active job")}</div>
    <div class="status-cell"><strong>${status.utilization.toFixed(1)}%</strong></div>
    <div class="status-cell">${status.scheduledHours.toFixed(1)}h</div>
    <div class="status-cell">${status.idleHours.toFixed(1)}h</div>
    <div class="status-cell">${escapeHtml(status.nextJobName || "None scheduled")}</div>
    <div class="status-cell"><span class="risk-pill ${riskClass(status.riskLabel)}">${escapeHtml(status.riskLabel)}</span></div>`;
}

function renderLeadTimeRiskPanel(groups) {
  const labels = [
    ["late", "Late"],
    ["at-risk", "At Risk"],
    ["blocked", "Blocked"],
    ["on-track", "On Track"],
  ];
  return `
    <section class="panel dashboard-panel">
      <h2>Lead-Time Risk</h2>
      <div class="risk-columns">
        ${labels
          .map(([key, label]) => {
            const jobs = groups[key] || [];
            return `
              <section class="risk-column">
                <h3>${label} <span>${jobs.length}</span></h3>
                ${
                  jobs.length
                    ? jobs.slice(0, 5).map(renderRiskJob).join("")
                    : `<p class="empty small">No ${label.toLowerCase()} jobs.</p>`
                }
              </section>`;
          })
          .join("")}
      </div>
    </section>`;
}

function renderRiskJob(risk) {
  const completion = risk.estimatedCompletion ? monthDay(risk.estimatedCompletion) : "Unscheduled";
  const slack = risk.slackHours === null ? "No due date" : `${risk.slackHours}h slack`;
  return `
    <article class="risk-job ${riskClass(risk.status)}">
      <strong>${escapeHtml(risk.job.name)}</strong>
      <span>Due ${escapeHtml(risk.dueDate || "not set")} | Est. ${escapeHtml(completion)}</span>
      <span>${escapeHtml(slack)} | ${escapeHtml(risk.assignedPrinter)}</span>
      ${risk.blockingReason ? `<span>${escapeHtml(risk.blockingReason)}</span>` : ""}
    </article>`;
}

function renderBottleneckDiagnosis(messages) {
  return `
    <section class="panel dashboard-panel">
      <h2>Bottleneck Diagnosis</h2>
      <div class="diagnosis-list">
        ${messages.map((message) => `<p>${escapeHtml(message)}</p>`).join("")}
      </div>
    </section>`;
}

function renderRecommendedActions(actions) {
  return `
    <section class="panel dashboard-panel">
      <h2>Recommended Actions</h2>
      <ol class="action-list">
        ${actions.map((action) => `<li>${escapeHtml(action)}</li>`).join("")}
      </ol>
    </section>`;
}

function renderQueueControls() {
  return `
    <div class="queue-controls">
      <label>Sort queue
        <select data-action="queue-sort">
          ${[
            ["urgency", "Urgency score"],
            ["due", "Due date"],
            ["duration", "Print time"],
            ["material", "Material"],
          ]
            .map(([value, label]) => option(label, value, queueSort))
            .join("")}
        </select>
      </label>
      <span class="drag-placeholder">Priority ordering is structured for drag/drop in a later pass.</span>
    </div>`;
}

function tabButton(id, label) {
  const selected = activeTab === id;
  return `<button class="tab-button ${selected ? "active" : ""}" type="button" role="tab" data-tab="${id}" aria-selected="${
    selected ? "true" : "false"
  }">${label}</button>`;
}

function renderJobQueues(state, jobCosts, riskByJob) {
  const { jobs, printers, inventory, scheduledJobs } = state;
  const queueJobs = sortQueueJobs(jobs.filter((job) => job.status === "queued"), scheduledJobs, inventory);
  const queues = [
    ...printers.map((printer) => ({
      id: printer.id,
      name: printer.name,
      jobs: queueJobs.filter((job) => effectivePrinterId(job, printers) === printer.id),
    })),
    {
      id: "",
      name: "Unassigned",
      jobs: queueJobs.filter((job) => !effectivePrinterId(job, printers)),
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
          ${renderJobs(queue.jobs, printers, jobCosts, riskByJob, scheduledJobs, inventory)}
        </section>`
    )
    .join("")}</div>`;
}

function renderJobs(jobs, printers, jobCosts, riskByJob, scheduledJobs, inventory) {
  if (!jobs.length) return `<p class="empty small">No jobs in this queue.</p>`;
  const costMap = Object.fromEntries(jobCosts.map((job) => [job.jobId, job.cost]));
  return `<div class="table">${jobs
    .map(
      (job) => {
        const risk = riskByJob[job.id];
        const score = urgencyScore(job, scheduledJobs, inventory);
        return `
        <div class="row job-row">
          <div>
            <strong>${escapeHtml(job.name)}</strong>
            <span>${statusText(job.status)} | Due ${escapeHtml(job.deadline || "not set")} | ${formatDuration(job.durationMinutes)}</span>
            <span>${materialsText(job.materials)} | ${jobDetails(job)}</span>
            <span>Urgency ${score} | Risk ${statusText(risk?.status || "on-track")}</span>
          </div>
          <div>${currency(costMap[job.id] || 0)}</div>
          <label class="check compact-check" title="Select for schedule commit">
            <input data-schedule-job value="${job.id}" type="checkbox" />
            Schedule
          </label>
          <select class="queue-select" data-action="update-job-priority" data-id="${job.id}" aria-label="Customer priority">
            ${["low", "normal", "high", "rush"].map((priority) => option(titleCase(priority), priority, job.customerPriority || "normal")).join("")}
          </select>
          ${renderPrinterSelect(job, printers)}
          <span class="risk-pill ${riskClass(risk?.status || "on-track")}">${statusText(risk?.status || "on-track")}</span>
          <button class="icon" data-action="delete-job" data-id="${job.id}" title="Remove job">x</button>
        </div>`;
      }
    )
    .join("")}</div>`;
}

function sortQueueJobs(jobs, scheduledJobs, inventory) {
  return [...jobs].sort((a, b) => {
    if (queueSort === "due") return dateSort(a.deadline, b.deadline);
    if (queueSort === "duration") return (b.durationMinutes || 0) - (a.durationMinutes || 0);
    if (queueSort === "material") return materialsText(a.materials).localeCompare(materialsText(b.materials));
    return urgencyScore(b, scheduledJobs, inventory) - urgencyScore(a, scheduledJobs, inventory);
  });
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

function renderAddPrinterForm() {
  return `
    <form class="printer-form" data-action="add-printer">
      <label>Name <input name="name" placeholder="Printer name" required /></label>
      <label>Extruders <input name="extruders" type="number" min="1" step="1" value="1" required /></label>
      <label class="check"><input name="disabled" type="checkbox" /> Maintenance / disabled</label>
      <label class="wide">Model or filename matchers
        <textarea name="modelMatchers" placeholder="Prusa XL, XLIS, customer-printer-code"></textarea>
      </label>
      <button class="primary" type="submit">Add printer</button>
    </form>`;
}

function renderPrinters(state) {
  if (!state.printers.length) return `<p class="empty">No printers configured.</p>`;
  return `
    <div class="printer-management-grid">
      ${state.printers
        .map((printer) => {
          const queued = state.jobs.filter((job) => effectivePrinterId(job, state.printers) === printer.id && job.status === "queued").length;
          const scheduled = state.scheduledJobs.filter((job) => job.printer_id === printer.id).length;
          const loadedSpools = state.inventory.filter((item) => item.printerId === printer.id).length;
          return `
            <article class="printer-card">
              <div class="printer-card-header">
                <div>
                  <h3>${escapeHtml(printer.name)}</h3>
                  <span>${printer.disabled ? "Maintenance / disabled" : "Available"} | ${printer.extruders} extruder${printer.extruders === 1 ? "" : "s"}</span>
                </div>
                <button class="danger" data-action="delete-printer" data-id="${printer.id}" ${
                  state.printers.length <= 1 ? "disabled" : ""
                }>Remove</button>
              </div>
              <dl class="printer-facts">
                <div><dt>Queued jobs</dt><dd>${queued}</dd></div>
                <div><dt>Scheduled jobs</dt><dd>${scheduled}</dd></div>
                <div><dt>Loaded spools</dt><dd>${loadedSpools}</dd></div>
              </dl>
              <div class="matcher-list">
                <strong>G-code matchers</strong>
                <span>${escapeHtml((printer.modelMatchers || []).join(", ") || "No matchers")}</span>
              </div>
            </article>`;
        })
        .join("")}
    </div>`;
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

function renderScheduleControls(state, schedule) {
  const queuedJobs = state.jobs.filter((job) => job.status === "queued");
  return `
    <div class="scheduler-toolbar">
      <details class="schedule-menu">
        <summary>Schedule</summary>
        <form class="schedule-controls" data-action="schedule-controls">
          <label>Month <input name="scheduleMonth" type="month" value="${state.settings.scheduleMonth}" /></label>
          <label>Week <input name="scheduleWeek" type="date" value="${state.settings.scheduleWeek}" /></label>
          <label>View
            <select name="scheduleView">${SCHEDULE_VIEWS.map((view) => option(titleCase(view), view, state.settings.scheduleView)).join("")}</select>
          </label>
          <label>Printer
            <select name="printerFilter">
              <option value="">All printers</option>
              ${state.printers.map((printer) => option(printer.name, printer.id, state.settings.printerFilter)).join("")}
            </select>
          </label>
          <label>Material <input name="materialFilter" value="${escapeHtml(state.settings.materialFilter || "")}" placeholder="All materials" /></label>
          <label>Queue
            <select name="queueFilter">
              ${PRODUCTION_STATUSES.map((status) =>
                option(statusText(status), status, state.settings.queueFilter)
              ).join("")}
            </select>
          </label>
        </form>
        ${renderCommitForm(state, queuedJobs)}
      </details>
      <details class="schedule-config">
        <summary>Scheduling rules</summary>
        ${renderSettings(state.settings)}
        ${renderChangeoverRules(state.changeoverRules)}
        ${renderServicerForm(state.servicerAvailability)}
      </details>
      ${scheduleMessage ? `<p class="scanner-message">${escapeHtml(scheduleMessage)}</p>` : ""}
      ${renderScheduleWarnings([...schedule.warnings])}
    </div>`;
}

function renderCommitForm(state, queuedJobs) {
  return `
    <form class="commit-form" data-action="commit-schedule">
      <label>Target week <input name="targetWeek" type="date" value="${state.settings.scheduleWeek}" /></label>
      <label>Target printer
        <select name="printerId">
          <option value="">Use queue printer</option>
          ${state.printers.map((printer) => option(printer.name, printer.id, state.settings.printerFilter)).join("")}
        </select>
      </label>
      <label>Preferred start <input name="preferredStart" type="datetime-local" /></label>
      <label>Priority
        <select name="priority">
          <option value="normal">Longest first</option>
          <option value="deadline">Deadline first</option>
          <option value="rush">Rush</option>
        </select>
      </label>
      <button class="primary" type="submit" ${queuedJobs.length ? "" : "disabled"}>Commit selected queued jobs</button>
    </form>`;
}

function renderChangeoverRules(rules) {
  return `
    <form class="settings" data-action="changeover-rules">
      <label>Default changeover <input name="default_changeover_minutes" type="number" min="0" step="5" value="${rules.default_changeover_minutes}" /></label>
      <label>Material change <input name="material_changeover_minutes" type="number" min="0" step="5" value="${rules.material_changeover_minutes}" /></label>
      <label>Color change <input name="color_changeover_minutes" type="number" min="0" step="5" value="${rules.color_changeover_minutes}" /></label>
      <label>Removal <input name="removal_required_minutes" type="number" min="0" step="5" value="${rules.removal_required_minutes}" /></label>
      <label>Setup <input name="setup_required_minutes" type="number" min="0" step="5" value="${rules.setup_required_minutes}" /></label>
      <label class="check"><input name="auto_complete_after_start" type="checkbox" ${rules.auto_complete_after_start !== false ? "checked" : ""} /> Auto-complete after start</label>
    </form>`;
}

function renderServicerForm(availability) {
  const names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const windows = [0, 1, 2, 3, 4, 5, 6].map(
    (day) => availability.find((window) => Number(window.day_of_week) === day) || {
      day_of_week: day,
      start_time: "08:00",
      end_time: "17:00",
      is_available: false,
    }
  );
  return `
    <form class="servicer-form" data-action="servicer-availability">
      <div></div>
      ${windows.map((window) => `<strong>${names[window.day_of_week]}</strong>`).join("")}
      <span>Available</span>
      ${windows
        .map((window) => `<label class="availability-cell"><input name="available-${window.day_of_week}" type="checkbox" ${window.is_available ? "checked" : ""} /></label>`)
        .join("")}
      <span>Start</span>
      ${windows.map((window) => `<input name="start-${window.day_of_week}" type="time" value="${window.start_time}" />`).join("")}
      <span>End</span>
      ${windows.map((window) => `<input name="end-${window.day_of_week}" type="time" value="${window.end_time}" />`).join("")}
    </form>`;
}

function renderSchedule(schedule, state) {
  const printers = state.settings.printerFilter
    ? state.printers.filter((printer) => printer.id === state.settings.printerFilter)
    : state.printers;
  const materialFilter = String(state.settings.materialFilter || "").toLowerCase();
  const blocks = materialFilter
    ? schedule.blocks.filter((block) => {
        const scheduledJob = state.scheduledJobs.find((job) => job.id === block.related_job_id);
        return !scheduledJob || String(scheduledJob.material || "").toLowerCase().includes(materialFilter);
      })
    : schedule.blocks;

  return `
    ${renderCapacityHeatmap(calculateCapacityHeatmap(printers, state.scheduledJobs, state.printerAvailability, state.settings.scheduleWeek || schedule.visibleStart, state.scheduleBlocks))}
    <section class="schedule-summary">
      ${metric("Scheduled print hours", (schedule.summaries.printMinutes / 60).toFixed(1))}
      ${metric("Available printer hours", (schedule.summaries.availableMinutes / 60).toFixed(0))}
      ${metric("Changeover hours", (schedule.summaries.changeoverMinutes / 60).toFixed(1))}
      ${metric("Idle printer hours", (schedule.summaries.idleMinutes / 60).toFixed(0))}
      ${metric("Filament cost month", currency(schedule.summaries.filamentCostMonth))}
    </section>
    <div class="month-context">
      ${renderMaterialSummary(schedule.summaries.materialByWeek, "Material usage by week")}
      ${renderMaterialSummary(schedule.summaries.materialByMonth, "Material usage by month")}
    </div>
    <div class="gantt month-gantt" data-days="${schedule.days.length}" title="Scroll over the schedule to zoom">
      ${renderCalendarHeader(schedule)}
      ${printers.map((printer) => renderGanttLane(printer, blocks.filter((block) => block.printer_id === printer.id), schedule, state)).join("")}
    </div>
    ${renderScheduledJobTable(schedule.jobs, state)}`;
}

function renderCapacityHeatmap(heatmap) {
  return `
    <section class="heatmap-panel">
      <div class="panel-title">
        <div>
          <h2>Capacity Heat Map</h2>
          <p>Remaining machine hours and overload warnings by printer and day.</p>
        </div>
      </div>
      <div class="capacity-heatmap">
        <div class="heatmap-label">Printer</div>
        ${heatmap[0]?.days.map((day) => `<div class="heatmap-label">${monthDay(day.date)}</div>`).join("") || ""}
        ${heatmap
          .map(
            (row) => `
              <div class="heatmap-printer">${escapeHtml(row.printer.name)}</div>
              ${row.days
                .map(
                  (day) => `
                    <div class="heatmap-cell ${day.overloaded ? "overloaded" : day.utilization < 35 ? "idle" : "balanced"}">
                      <strong>${day.utilization.toFixed(0)}%</strong>
                      <span>${day.remainingHours.toFixed(1)}h left</span>
                    </div>`
                )
                .join("")}`
          )
          .join("")}
      </div>
    </section>`;
}

function renderCalendarHeader(schedule) {
  const width = scheduleTrackWidth(schedule);
  return `
    <div class="gantt-header">
      <span>Printer</span>
      <div class="calendar-days" style="grid-template-columns: repeat(${schedule.days.length}, minmax(52px, 1fr)); min-width: ${width}px;">
        ${schedule.days.map((day) => `<span>${monthDay(day)}</span>`).join("")}
      </div>
    </div>`;
}

function renderGanttLane(printer, blocks, schedule, state) {
  const range = { start: schedule.visibleStart, end: schedule.visibleEnd };
  const serviceWindows = schedule.days.flatMap((day) => availabilityWindowsForDate(day, state.servicerAvailability));
  return `
    <section class="gantt-lane">
      <div class="gantt-lane-label">
        <h3>${escapeHtml(printer.name)}</h3>
        <span>${blocks.filter((block) => block.block_type === "Print").length} planned job${blocks.length === 1 ? "" : "s"}</span>
      </div>
      <div class="gantt-track" style="min-width: ${scheduleTrackWidth(schedule)}px;">
        ${serviceWindows.map((window) => renderServiceWindow(window, range)).join("")}
        ${
          blocks.length
            ? blocks.map((block) => renderGanttBar(block, range, state)).join("")
            : `<p class="empty small">No scheduled jobs.</p>`
        }
      </div>
    </section>`;
}

function renderGanttBar(block, range, state) {
  const start = new Date(block.start_time);
  const end = new Date(block.end_time);
  const offset = Math.max(0, ((start - range.start) / (range.end - range.start)) * 100);
  const width = Math.max(1.25, ((end - start) / (range.end - range.start)) * 100);
  const scheduledJob = state.scheduledJobs.find((job) => job.id === block.related_job_id);
  const sourceJob = state.jobs.find((job) => job.id === scheduledJob?.print_job_id);
  const label = block.block_type === "Print" ? sourceJob?.name || block.label : block.label;
  const title = [
    label,
    block.block_type,
    scheduledJob?.material,
    `${dateTime(block.start_time)}-${dateTime(block.end_time)}`,
    scheduledJob?.status,
  ]
    .filter(Boolean)
    .join(" | ");

  return `
    <article class="gantt-bar ${blockClass(block.block_type)}" style="left: ${offset}%; width: ${width}%;" title="${escapeHtml(title)}">
      <strong>${escapeHtml(label)}</strong>
      <span>${escapeHtml(block.block_type)} | ${timeOnly(block.start_time)}-${timeOnly(block.end_time)}</span>
    </article>`;
}

function renderServiceWindow(window, range) {
  const offset = Math.max(0, ((window.start - range.start) / (range.end - range.start)) * 100);
  const width = Math.max(0.5, ((window.end - window.start) / (range.end - range.start)) * 100);
  return `<span class="service-window" style="left: ${offset}%; width: ${width}%;" title="${escapeHtml(window.label)}"></span>`;
}

function renderScheduledJobTable(jobs, state) {
  if (!jobs.length) return `<p class="empty">No scheduled calendar items in this view.</p>`;
  return `<div class="table schedule-table">${jobs
    .map((scheduledJob) => {
      const sourceJob = state.jobs.find((job) => job.id === scheduledJob.print_job_id) || {};
      const printer = state.printers.find((item) => item.id === scheduledJob.printer_id);
      const completionText =
        scheduledJob.status === "printing" && state.changeoverRules?.auto_complete_after_start !== false
          ? `Completes ${relativeCompletionText(scheduledJob.expected_finish_at)}`
          : statusText(scheduledJob.status);
      return `
        <div class="row scheduled-row">
          <div>
            <strong>${escapeHtml(sourceJob.name || "Scheduled job")}</strong>
            <span>${escapeHtml(printer?.name || "Printer")} | ${escapeHtml(scheduledJob.material)} | ${statusText(scheduledJob.status)}</span>
            <span>${dateTime(scheduledJob.scheduled_start)} to ${dateTime(scheduledJob.scheduled_finish)} | ${formatDuration(scheduledJob.estimated_duration_minutes)}</span>
          </div>
          <button class="secondary" data-action="start-scheduled-job" data-id="${scheduledJob.id}" ${scheduledJob.status === "scheduled" ? "" : "disabled"}>Start</button>
          <span class="completion-pill ${scheduledJob.status === "scheduled" ? "muted-pill" : ""}">${escapeHtml(completionText)}</span>
          <button class="icon danger-icon" data-action="unschedule-job" data-id="${scheduledJob.id}" title="Delete scheduled item">x</button>
        </div>`;
    })
    .join("")}</div>`;
}

function renderMaterialSummary(summary, title) {
  const entries = Array.isArray(summary)
    ? summary
    : Object.entries(summary).map(([key, value]) => [key, value]);
  if (!entries.length) return `<section class="mini-summary"><h3>${title}</h3><p class="empty small">No scheduled material use.</p></section>`;
  return `<section class="mini-summary"><h3>${title}</h3>${entries
    .map(([key, value]) => {
      const text =
        typeof value === "object"
          ? Object.entries(value)
              .map(([material, grams]) => `${material} ${Math.round(grams)}g`)
              .join(", ")
          : `${Math.round(value)}g`;
      return `<p><strong>${escapeHtml(key)}</strong><span>${escapeHtml(text)}</span></p>`;
    })
    .join("")}</section>`;
}

function renderDashboardSchedule(schedule) {
  return `
    <section class="schedule-summary dashboard-schedule">
      ${metric("Scheduled print hours", (schedule.summaries.printMinutes / 60).toFixed(1))}
      ${metric("Available printer hours", (schedule.summaries.availableMinutes / 60).toFixed(0))}
      ${metric("Changeover hours", (schedule.summaries.changeoverMinutes / 60).toFixed(1))}
      ${metric("Idle printer hours", (schedule.summaries.idleMinutes / 60).toFixed(0))}
      ${metric("Filament cost month", currency(schedule.summaries.filamentCostMonth))}
    </section>`;
}

function scheduleTrackWidth(schedule) {
  return zoomedTrackWidth(schedule.days.length);
}

function zoomedTrackWidth(dayCount) {
  const dayWidth = dayCount <= 7 ? 136 : 74;
  return Math.round(dayCount * dayWidth * scheduleZoom);
}

function applyScheduleZoom(gantt) {
  const dayCount = Number(gantt.dataset.days) || 31;
  const width = `${zoomedTrackWidth(dayCount)}px`;
  gantt.querySelector(".calendar-days")?.style.setProperty("min-width", width);
  gantt.querySelectorAll(".gantt-track").forEach((track) => {
    track.style.setProperty("min-width", width);
  });
  gantt.querySelectorAll(".gantt-header, .gantt-lane").forEach((row) => {
    row.style.setProperty("width", `calc(170px + ${width} + 10px)`);
  });
}

function schedulePrintCompletionTimer(state, commit) {
  if (printCompletionTimer) window.clearTimeout(printCompletionTimer);
  const nextFinish = state.scheduledJobs
    .filter((job) => job.status === "printing" && job.expected_finish_at)
    .map((job) => new Date(job.expected_finish_at).getTime())
    .filter((time) => Number.isFinite(time))
    .sort((a, b) => a - b)[0];
  if (!nextFinish) return;

  const delay = Math.max(250, Math.min(nextFinish - Date.now(), 2147483647));
  printCompletionTimer = window.setTimeout(() => {
    const nextState = completeElapsedPrintingJobs(state);
    if (nextState !== state) commit(nextState);
  }, delay);
}

function relativeCompletionText(value) {
  if (!value) return "after estimated print time";
  const remainingMinutes = Math.ceil((new Date(value) - new Date()) / 60000);
  if (remainingMinutes <= 0) return "now";
  return `in ${formatDuration(remainingMinutes)}`;
}

function renderScheduleWarnings(warnings) {
  if (!warnings.length) return `<p class="empty">No schedule warnings.</p>`;
  return `<div class="warnings">${warnings.map((warning) => `<p>${escapeHtml(warning)}</p>`).join("")}</div>`;
}

function blockClass(type) {
  return `block-${String(type).toLowerCase()}`;
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

function summarizeWeeklyCapacity(state, targetWeek) {
  const printerMetrics = state.printers.map((printer) =>
    calculatePrinterUtilization(
      printer,
      state.scheduledJobs,
      state.scheduleBlocks,
      targetWeek,
      state.printerAvailability
    )
  );
  const availableHours = printerMetrics.reduce((total, metric) => total + metric.availableHours, 0);
  const scheduledHours = printerMetrics.reduce((total, metric) => total + metric.scheduledHours, 0);
  const printHours = printerMetrics.reduce((total, metric) => total + metric.printHours, 0);
  return {
    availableHours,
    scheduledHours,
    changeoverHours: printerMetrics.reduce((total, metric) => total + metric.changeoverHours, 0),
    idleHours: Math.max(0, availableHours - scheduledHours),
    utilization: availableHours ? (printHours / availableHours) * 100 : 0,
    overloaded: scheduledHours > availableHours,
  };
}

function purchaseMetric(purchaseNeeds) {
  const grams = sum(purchaseNeeds);
  return grams > 0 ? `${Math.ceil(grams)}g` : "Covered";
}

function statusLabel(status) {
  return status === "ready" ? "Ready to consume" : "Reserve";
}

function statusText(status = "queued") {
  const labels = {
    staged: "Staged",
    queued: "Queued",
    scheduled: "Scheduled",
    printing: "Printing",
    paused: "Paused",
    failed: "Failed",
    "waiting-material": "Waiting for Material",
    "waiting-removal": "Waiting for Removal",
    "needs-inspection": "Needs Inspection",
    "reprint-required": "Reprint Required",
    "post-processing": "Post-Processing",
    "ready-pickup": "Ready for Pickup",
    completed: "Completed",
    done: "Completed",
    late: "Late",
    "at-risk": "At Risk",
    blocked: "Blocked",
    "on-track": "On Track",
  };
  return labels[status] || titleCase(status);
}

function riskClass(value = "") {
  const normalized = String(value).toLowerCase();
  if (normalized.includes("late") || normalized.includes("overloaded") || normalized.includes("failed")) return "risk-danger";
  if (normalized.includes("risk") || normalized.includes("underutilized") || normalized.includes("waiting") || normalized.includes("paused")) return "risk-warning";
  if (normalized.includes("blocked") || normalized.includes("maintenance")) return "risk-blocked";
  return "risk-good";
}

function dateSort(a, b) {
  if (!a && !b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  return new Date(a) - new Date(b);
}

function titleCase(value = "") {
  return String(value)
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function updateInventoryItem(item, formData) {
  const spoolWeight = Number(formData.get("starting_weight")) || 0;
  const remainingWeight = Number(formData.get("remaining_weight")) || 0;
  const costPerSpool = Number(formData.get("cost")) || 0;
  const isAvailable = remainingWeight > 1;
  const printerId = isAvailable ? String(formData.get("printerId") || "") : "";
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

function createPrinterFromForm(formData, printers) {
  const name = String(formData.get("name") || "").trim();
  const id = uniquePrinterId(slugify(name || "printer"), printers);
  const modelMatchers = String(formData.get("modelMatchers") || "")
    .split(/[\n,]+/)
    .map((matcher) => matcher.trim())
    .filter(Boolean);

  return {
    id,
    name: name || `Printer ${printers.length + 1}`,
    modelMatchers: [...new Set([name, ...modelMatchers].filter(Boolean))],
    extruders: Math.max(1, Number(formData.get("extruders")) || 1),
    disabled: formData.get("disabled") === "on",
  };
}

function removePrinterFromState(state, printerId) {
  return {
    ...state,
    printers: state.printers.filter((printer) => printer.id !== printerId),
    jobs: state.jobs.map((job) =>
      job.printerId === printerId ? { ...job, printerId: "", status: job.status === "scheduled" ? "queued" : job.status } : job
    ),
    inventory: state.inventory.map((item) =>
      item.printerId === printerId
        ? {
            ...item,
            printerId: "",
            status: "reserve",
            storage_location: item.storage_location || "Reserve",
            location: item.location || "Reserve",
          }
        : item
    ),
    scheduledJobs: state.scheduledJobs.filter((job) => job.printer_id !== printerId),
    scheduleBlocks: state.scheduleBlocks.filter((block) => block.printer_id !== printerId),
    printerAvailability: state.printerAvailability.filter((window) => window.printer_id !== printerId),
    settings: {
      ...state.settings,
      printerFilter: state.settings.printerFilter === printerId ? "" : state.settings.printerFilter,
    },
  };
}

function uniquePrinterId(baseId, printers) {
  const existing = new Set(printers.map((printer) => printer.id));
  let id = baseId || "printer";
  let index = 2;
  while (existing.has(id)) {
    id = `${baseId}-${index}`;
    index += 1;
  }
  return id;
}

function slugify(value) {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
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

function monthDay(value) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
  }).format(new Date(value));
}

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
