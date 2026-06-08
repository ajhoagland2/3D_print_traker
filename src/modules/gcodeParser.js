const GRAMS_PER_METER_175_PLA = 2.98;

export async function parseGcodeFile(file) {
  const text = await file.text();
  const lines = text.split(/\r?\n/);
  const metadata = scanMetadata(lines);
  const toolUsage = parseToolUsage(lines, metadata.material);
  const materials = normalizeMaterials(metadata, toolUsage);
  const durationMinutes = metadata.timeMinutes || estimateDurationFromMoves(lines);
  const timeSource = metadata.timeMinutes ? metadata.timeSource : "movement fallback";

  return {
    id: crypto.randomUUID(),
    fileName: file.name,
    uploadedAt: new Date().toISOString(),
    durationMinutes,
    timeSource,
    filamentGrams: sumValues(materials),
    filamentMeters: metadata.filamentMeters,
    materials,
    toolUsage,
    metadataDiagnostics: metadata.diagnostics,
    material: Object.keys(materials)[0] || metadata.material || "PLA",
    estimatedCompletion: completionFromNow(durationMinutes),
    parserNotes: metadata.timeMinutes
      ? [`Print time read from ${metadata.timeSource}.`, ...metadata.notes]
      : metadata.notes,
  };
}

function scanMetadata(lines) {
  const data = {
    timeMinutes: 0,
    timeSource: "",
    filamentMeters: 0,
    filamentGrams: 0,
    material: "PLA",
    notes: [],
    diagnostics: {
      slicerHints: [],
      timeLikeLines: [],
    },
    toolGrams: {},
    toolMaterials: {},
  };

  for (const line of lines) {
    const clean = line.replace(/^;\s*/, "").trim();
    const lower = clean.toLowerCase();
    collectDiagnostics(data.diagnostics, clean, lower);

    if (!data.timeMinutes) {
      const timeMetadata = parseTimeLine(clean, lower);
      data.timeMinutes = timeMetadata.minutes;
      data.timeSource = timeMetadata.source;
    }

    const m73Minutes = parseM73TimeLine(clean);
    if (m73Minutes > data.timeMinutes) {
      data.timeMinutes = m73Minutes;
      data.timeSource = "M73 remaining-time metadata";
    }

    const filament = parseFilamentLine(clean, lower);
    if (filament.grams) data.filamentGrams += filament.grams;
    if (filament.meters) data.filamentMeters += filament.meters;
    if (filament.tool && filament.grams) {
      data.toolGrams[filament.tool] = (data.toolGrams[filament.tool] || 0) + filament.grams;
    }

    const material = parseMaterialLine(clean, lower);
    if (material.value) {
      data.material = material.value;
      if (material.tool) data.toolMaterials[material.tool] = material.value;
    }
  }

  if (!data.timeMinutes) {
    data.notes.push("No supported slicer time metadata found; checked TIME, print_time, estimated print time, and M73 R/S.");
    if (!data.diagnostics.timeLikeLines.length) {
      data.notes.push("No time-like metadata comments were found in the uploaded G-code.");
    }
  }
  if (!data.filamentGrams && data.filamentMeters) {
    data.filamentGrams = data.filamentMeters * GRAMS_PER_METER_175_PLA;
    data.notes.push("Filament weight estimated from 1.75mm PLA density.");
  }
  if (!data.filamentGrams) data.notes.push("No filament weight metadata found.");

  return data;
}

function collectDiagnostics(diagnostics, clean, lower) {
  if (!clean || diagnostics.timeLikeLines.length >= 12 && diagnostics.slicerHints.length >= 6) return;

  if (
    diagnostics.timeLikeLines.length < 12 &&
    /(^m73\b|time|duration|elapsed|remaining|estimate|eta|print_time)/i.test(clean)
  ) {
    diagnostics.timeLikeLines.push(clean.slice(0, 180));
  }

  if (
    diagnostics.slicerHints.length < 6 &&
    /(generated|sliced|slicer|cura|prusaslicer|orcaslicer|bambu|superslicer|simplify3d|ideamaker|creality|flashprint|lychee|chitubox)/i.test(lower)
  ) {
    diagnostics.slicerHints.push(clean.slice(0, 180));
  }
}

function parseTimeLine(clean, lower) {
  const candidates = [
    {
      pattern: /^time\s*[:=]\s*(.+)$/i,
      source: "Cura TIME metadata",
      parser: parseSecondsOrDuration,
    },
    {
      pattern: /^(?:estimated\s+)?printing\s+time(?:\s*\([^)]*\))?\s*[:=]\s*(.+)$/i,
      source: "Prusa/SuperSlicer printing time metadata",
      parser: parseDurationText,
    },
    {
      pattern: /^(?:estimated\s+)?print(?:ing)?_?time\s*[:=]\s*(.+)$/i,
      source: "generic print_time metadata",
      parser: parseSecondsOrDuration,
    },
    {
      pattern: /^(?:total\s+)?estimated\s+print(?:ing)?\s+time\s*[:=]\s*(.+)$/i,
      source: "slicer estimated print time metadata",
      parser: parseDurationText,
    },
    {
      pattern: /^(?:total\s+)?print(?:ing)?\s+time\s*[:=]\s*(.+)$/i,
      source: "slicer print time metadata",
      parser: parseSecondsOrDuration,
    },
    {
      pattern: /^estimated_?print(?:ing)?_?time(?:_s|_sec|_seconds)?\s*[:=]\s*(.+)$/i,
      source: "slicer estimated print time seconds metadata",
      parser: parseSecondsOrDuration,
    },
    {
      pattern: /^;?\s*estimated printing time.*$/i,
      source: "slicer estimated printing time comment",
      parser: parseDurationText,
      wholeLine: true,
    },
    {
      pattern: /^;?\s*print time.*$/i,
      source: "slicer print time comment",
      parser: parseDurationText,
      wholeLine: true,
    },
  ];

  for (const candidate of candidates) {
    if (!candidate.wholeLine && !candidate.pattern.test(clean)) continue;
    if (candidate.wholeLine && !candidate.pattern.test(clean)) continue;
    const match = clean.match(candidate.pattern);
    const value = candidate.wholeLine ? clean : match?.[1] || "";
    const minutes = candidate.parser(value);
    if (minutes > 0) return { minutes, source: candidate.source };
  }

  if (lower.includes("estimated printing time") || lower.includes("printing time")) {
    const minutes = parseDurationText(clean);
    if (minutes > 0) return { minutes, source: "slicer time comment" };
  }

  return { minutes: 0, source: "" };
}

function parseM73TimeLine(clean) {
  if (!/^M73\b/i.test(clean)) return 0;
  const remainingMinutes = Math.max(
    mCodeValue(clean, "R"),
    mCodeValue(clean, "S"),
  );
  return remainingMinutes > 0 ? remainingMinutes : 0;
}

function parseFilamentLine(clean, lower) {
  if (!lower.includes("filament") && !lower.includes("material used")) return {};

  const toolMatch = clean.match(/\b(T\d+|extruder\s*\d+)\b/i);
  const tool = toolMatch ? toolMatch[1].replace(/\s+/g, "").toUpperCase() : "";
  const labeledUnit = clean.match(/\[(g|kg|m|mm)\]\s*[:=]\s*([\d.]+)/i);
  const grams = unitValue(labeledUnit, "g") || unitValue(labeledUnit, "kg") * 1000 || matchUnit(clean, /([\d.]+)\s*g\b/i);
  const meters = unitValue(labeledUnit, "m") || matchUnit(clean, /([\d.]+)\s*m\b/i);
  const millimeters = unitValue(labeledUnit, "mm") || matchUnit(clean, /([\d.]+)\s*mm\b/i);

  return {
    tool,
    grams,
    meters: meters || millimeters / 1000,
  };
}

function parseMaterialLine(clean, lower) {
  if (!/(filament_type|material|filament type)/i.test(clean)) return {};
  const toolMatch = clean.match(/\b(T\d+|extruder\s*\d+)\b/i);
  const value = clean
    .split(/[:=]/)
    .pop()
    .split(",")[0]
    .trim()
    .replace(/["']/g, "")
    .toUpperCase();
  return {
    tool: toolMatch ? toolMatch[1].replace(/\s+/g, "").toUpperCase() : "",
    value: normalizeMaterial(value),
  };
}

function parseToolUsage(lines, fallbackMaterial) {
  const tools = {};
  let activeTool = "T0";
  let lastE = 0;

  for (const line of lines) {
    const toolChange = line.match(/^T(\d+)/);
    if (toolChange) {
      activeTool = `T${toolChange[1]}`;
      tools[activeTool] ||= { grams: 0, material: fallbackMaterial };
      continue;
    }

    const extrusion = line.match(/\bE(-?[\d.]+)/);
    if (!extrusion) continue;
    const nextE = Number(extrusion[1]);
    if (!Number.isFinite(nextE)) continue;
    const delta = Math.max(0, nextE - lastE);
    lastE = nextE;
    tools[activeTool] ||= { grams: 0, material: fallbackMaterial };
    tools[activeTool].grams += (delta / 1000) * GRAMS_PER_METER_175_PLA;
  }

  return Object.entries(tools).map(([tool, usage]) => ({
    tool,
    material: usage.material,
    grams: usage.grams,
  }));
}

function normalizeMaterials(metadata, toolUsage) {
  const materials = {};

  if (Object.keys(metadata.toolGrams).length) {
    for (const [tool, grams] of Object.entries(metadata.toolGrams)) {
      const material = metadata.toolMaterials[tool] || metadata.material;
      materials[material] = (materials[material] || 0) + grams;
    }
  } else if (metadata.filamentGrams) {
    materials[metadata.material] = metadata.filamentGrams;
  } else {
    for (const usage of toolUsage) {
      materials[usage.material] = (materials[usage.material] || 0) + usage.grams;
    }
  }

  return materials;
}

function parseDurationText(text) {
  const normalized = String(text).replace(/_/g, " ");
  const clock = parseClockDuration(normalized);
  if (clock) return clock;

  const days = matchUnit(normalized, /(\d+(?:\.\d+)?)\s*(?:d|day|days)\b/i);
  const hours = matchUnit(normalized, /(\d+(?:\.\d+)?)\s*(?:h|hr|hrs|hour|hours)\b/i);
  const minutes = matchUnit(normalized, /(\d+(?:\.\d+)?)\s*(?:m|min|mins|minute|minutes)\b/i);
  const seconds = matchUnit(normalized, /(\d+(?:\.\d+)?)\s*(?:s|sec|secs|second|seconds)\b/i);
  if (days || hours || minutes || seconds) return days * 1440 + hours * 60 + minutes + seconds / 60;

  return 0;
}

function parseSecondsOrDuration(text) {
  const duration = parseDurationText(text);
  if (duration) return duration;
  return parseNumberAsSeconds(text);
}

function parseNumberAsSeconds(text) {
  const number = Number((String(text).match(/(\d+(?:\.\d+)?)/) || [])[1]);
  return Number.isFinite(number) ? number / 60 : 0;
}

function parseClockDuration(text) {
  const match = String(text).match(/\b(?:(\d+):)?(\d{1,2}):(\d{2})\b/);
  if (!match) return 0;
  const hours = Number(match[1] || 0);
  const minutes = Number(match[2] || 0);
  const seconds = Number(match[3] || 0);
  return hours * 60 + minutes + seconds / 60;
}

function mCodeValue(text, letter) {
  const match = String(text).match(new RegExp(`\\b${letter}(-?\\d+(?:\\.\\d+)?)\\b`, "i"));
  if (!match) return 0;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : 0;
}

function estimateDurationFromMoves(lines) {
  const motionLines = lines.filter((line) => /^G[01]\b/.test(line)).length;
  return Math.max(10, Math.round(motionLines / 55));
}

function matchUnit(text, pattern) {
  const match = text.match(pattern);
  return match ? Number(match[1]) : 0;
}

function unitValue(match, unit) {
  if (!match || match[1].toLowerCase() !== unit) return 0;
  const value = Number(match[2]);
  return Number.isFinite(value) ? value : 0;
}

function normalizeMaterial(value) {
  if (value.includes("PETG")) return "PETG";
  if (value.includes("ASA")) return "ASA";
  if (value.includes("ABS")) return "ABS";
  if (value.includes("TPU")) return "TPU";
  if (value.includes("NYLON") || value.includes("PA")) return "Nylon";
  if (value.includes("PC")) return "PC";
  if (value.includes("PLA")) return "PLA";
  return value || "PLA";
}

function completionFromNow(minutes) {
  const date = new Date(Date.now() + minutes * 60 * 1000);
  return date.toISOString();
}

function sumValues(object) {
  return Object.values(object).reduce((sum, value) => sum + value, 0);
}
