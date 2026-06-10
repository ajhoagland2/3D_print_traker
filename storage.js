import { DEFAULT_PRINTERS, detectPrinterId, normalizePrinters } from "./printers.js";
import { autoAssignReadySpools, DEFAULT_INVENTORY, normalizeInventory, normalizeProducts } from "./inventory.js";
import {
  defaultChangeoverRules,
  defaultServicerAvailability,
  normalizeScheduleState,
  startOfWeek,
} from "./scheduler.js";

const STORAGE_KEY = "artaic-print-planner-v1";

export const defaultState = {
  jobs: [],
  products: [],
  inventory: DEFAULT_INVENTORY,
  printers: DEFAULT_PRINTERS,
  scheduledJobs: [],
  servicerAvailability: defaultServicerAvailability(),
  changeoverRules: defaultChangeoverRules(),
  printerAvailability: [],
  scheduleBlocks: [],
  settings: {
    dayStart: "08:00",
    dayEnd: "18:00",
    changeoverStart: "08:00",
    changeoverEnd: "18:00",
    deadline: nextFriday(),
    allowOvernight: true,
    scheduleMonth: new Date().toISOString().slice(0, 7),
    scheduleWeek: startOfWeek(new Date()).toISOString().slice(0, 10),
    scheduleView: "month",
    printerFilter: "",
    materialFilter: "",
    queueFilter: "queued",
  },
};

export function loadState() {
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (!saved) return structuredClone(defaultState);
    return normalizeState({ ...structuredClone(defaultState), ...JSON.parse(saved) });
  } catch {
    return structuredClone(defaultState);
  }
}

export function saveState(state) {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

export function clearState() {
  window.localStorage.removeItem(STORAGE_KEY);
}

export function exportState(state) {
  const blob = new Blob([JSON.stringify(state, null, 2)], {
    type: "application/json",
  });
  return URL.createObjectURL(blob);
}

export async function importState(file) {
  const text = await file.text();
  const parsed = JSON.parse(text);
  return normalizeState({ ...structuredClone(defaultState), ...parsed });
}

export function normalizeState(state) {
  const printers = normalizePrinters(state.printers);
  const products = normalizeProducts(state.products);
  const scheduledIds = new Set((state.scheduledJobs || []).map((job) => job.print_job_id));
  const jobs = state.jobs.map((job) => ({
    ...job,
    printerId: job.printerId || detectPrinterId(job.metadata, `${job.fileName || ""} ${job.name || ""}`, printers),
    status: job.status || (scheduledIds.has(job.id) ? "scheduled" : "queued"),
  }));
  const inventory = autoAssignReadySpools(jobs, normalizeInventory(state.inventory), printers);

  return normalizeScheduleState({
    ...state,
    printers,
    products,
    inventory,
    jobs,
    settings: {
      ...defaultState.settings,
      ...state.settings,
    },
  });
}

function nextFriday() {
  const date = new Date();
  const day = date.getDay();
  const diff = (5 - day + 7) % 7 || 7;
  date.setDate(date.getDate() + diff);
  return date.toISOString().slice(0, 10);
}
