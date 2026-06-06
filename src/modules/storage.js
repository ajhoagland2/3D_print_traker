const STORAGE_KEY = "artaic-print-planner-v1";

export const defaultState = {
  jobs: [],
  inventory: [],
  settings: {
    printerCount: 3,
    dayStart: "08:00",
    dayEnd: "18:00",
    deadline: nextFriday(),
    allowOvernight: true,
  },
};

export function loadState() {
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (!saved) return structuredClone(defaultState);
    return { ...structuredClone(defaultState), ...JSON.parse(saved) };
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
  return { ...structuredClone(defaultState), ...parsed };
}

function nextFriday() {
  const date = new Date();
  const day = date.getDay();
  const diff = (5 - day + 7) % 7 || 7;
  date.setDate(date.getDate() + diff);
  return date.toISOString().slice(0, 10);
}
