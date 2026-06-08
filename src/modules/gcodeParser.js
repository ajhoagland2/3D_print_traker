import { detectPrinterId } from "./printers.js";

const TIME_PATTERNS = [
  /;?\s*estimated\s*printing\s*time\s*(?:\(normal mode\))?\s*[:=]\s*(.+)$/i,
  /;?\s*time\s*[:=]\s*(.+)$/i,
  /;?\s*print\s*time\s*[:=]\s*(.+)$/i,
];

const FILAMENT_PATTERNS = [
  /;?\s*filament\s*used\s*\[?g\]?\s*[:=]\s*([\d.,\s]+)/i,
  /;?\s*filament\s*used\s*[:=].*?([\d.,\s]+)\s*g/i,
  /;?\s*filament\s*weight\s*[:=]\s*([\d.,\s]+)/i,
];

const FILAMENT_LENGTH_PATTERN = /;?\s*filament\s*used\s*[:=]\s*([\d.]+)\s*m\b/i;
const PLA_DENSITY_G_PER_CM3 = 1.24;
const DEFAULT_FILAMENT_DIAMETER_MM = 1.75;

export async function parseGcodeFile(file) {
  const text = await file.text();
  return parseGcode(text, file.name);
}

export function parseGcode(text, fileName = "Untitled print") {
  const lines = text.split(/\r?\n/);
  const isBinaryGcode = text.startsWith("GCDE");
  const metadata = extractMetadata(lines);
  const materials = detectMaterials(lines);
  const filamentGrams = detectFilamentGrams(lines);
  const durationMinutes = detectDurationMinutes(lines);
  const toolheads = isBinaryGcode ? [] : detectToolheads(lines);
  const materialUses = buildMaterialUses(materials, filamentGrams);

  return {
    id: crypto.randomUUID(),
    name: cleanName(fileName),
    fileName,
    printerId: detectPrinterId(metadata, fileName),
    materials: aggregateMaterials(materialUses),
    durationMinutes,
    toolheads: toolheads.length ? toolheads : materialUses.map((_, index) => `T${index}`),
    materialUses,
    metadata,
    deadline: "",
    status: "queued",
    notes: "",
    createdAt: new Date().toISOString(),
  };
}

function extractMetadata(lines) {
  const metadata = {};
  for (const line of lines) {
    const match =
      line.match(/^;?\s*([A-Za-z][\w\s[\]()/-]+)\s*=\s*(.+)$/) ||
      line.match(/^;?\s*([A-Za-z][\w\s[\]()/-]+)\s*:\s*(.+)$/);
    if (!match) {
      const generated = line.match(/^;?\s*Generated with\s+(.+)$/i);
      if (generated) metadata.generated_with = generated[1].trim();
      continue;
    }
    const key = match[1].trim().replace(/\s+/g, "_").replace(/-/g, "_").toLowerCase();
    metadata[key] = match[2].trim();
  }
  return metadata;
}

function detectMaterials(lines) {
  const materialLine = lines.find((line) =>
    /filament_type|filament type|material/i.test(line)
  );
  const match = materialLine?.match(/(?:filament_type|filament type|material)\s*=\s*(.+)$/i);
  return splitValues(match?.[1] || "PLA", ";").map((value) => value.toUpperCase());
}

function detectFilamentGrams(lines) {
  for (const line of lines) {
    const lengthMatch = line.match(FILAMENT_LENGTH_PATTERN);
    if (lengthMatch) return [filamentMetersToGrams(Number(lengthMatch[1]))];
    for (const pattern of FILAMENT_PATTERNS) {
      const match = line.match(pattern);
      if (match) return splitValues(match[1], ",").map((value) => Math.max(0, Number(value) || 0));
    }
  }
  return [0];
}

function detectDurationMinutes(lines) {
  for (const line of lines) {
    const curaTime = line.match(/^;TIME:(\d+(?:\.\d+)?)$/i);
    if (curaTime) return Math.round(Number(curaTime[1]) / 60);
    for (const pattern of TIME_PATTERNS) {
      const match = line.match(pattern);
      if (match) return parseDuration(match[1]);
    }
  }
  return 0;
}

function detectToolheads(lines) {
  const tools = new Set();
  for (const line of lines) {
    const match = line.match(/^T(\d+)/);
    if (match) tools.add(`T${match[1]}`);
  }
  return [...tools];
}

function parseDuration(value) {
  const text = value.toLowerCase();
  const hours = Number(text.match(/(\d+(?:\.\d+)?)\s*h/)?.[1] || 0);
  const minutes = Number(text.match(/(\d+(?:\.\d+)?)\s*m/)?.[1] || 0);
  const seconds = Number(text.match(/(\d+(?:\.\d+)?)\s*s/)?.[1] || 0);
  if (hours || minutes || seconds) return Math.round(hours * 60 + minutes + seconds / 60);
  const numeric = Number(text.match(/(\d+(?:\.\d+)?)/)?.[1]);
  return Number.isFinite(numeric) ? Math.round(numeric) : 0;
}

function filamentMetersToGrams(meters) {
  if (!Number.isFinite(meters)) return 0;
  const radius = DEFAULT_FILAMENT_DIAMETER_MM / 2;
  const volumeMm3 = Math.PI * radius * radius * meters * 1000;
  const volumeCm3 = volumeMm3 / 1000;
  return Math.round(volumeCm3 * PLA_DENSITY_G_PER_CM3 * 100) / 100;
}

function buildMaterialUses(materials, grams) {
  const count = Math.max(materials.length, grams.length);
  return Array.from({ length: count }, (_, index) => ({
    toolhead: `T${index}`,
    material: (materials[index] || materials[0] || "PLA").toUpperCase(),
    grams: grams[index] || 0,
  })).filter((use) => use.grams > 0 || count === 1);
}

function aggregateMaterials(materialUses) {
  return materialUses.reduce((totals, use) => {
    totals[use.material] = (totals[use.material] || 0) + use.grams;
    return totals;
  }, {});
}

function splitValues(value, delimiter) {
  return String(value)
    .split(delimiter)
    .map((part) => part.trim())
    .filter(Boolean);
}

function cleanName(fileName) {
  return fileName.replace(/\.(bgcode|gcode|gco|gc)$/i, "").replace(/[_-]+/g, " ").trim();
}
