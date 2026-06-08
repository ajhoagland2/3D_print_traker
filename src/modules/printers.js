export const DEFAULT_PRINTERS = [
  {
    id: "prusa-xl-dual",
    name: "PrusaXL",
    modelMatchers: ["XLIS", "XL2IS", "XL2", "Prusa XL", "PrusaXL", "Original Prusa XL"],
    extruders: 2,
  },
  {
    id: "ender-5-plus",
    name: "Creality Ender 5 Plus",
    modelMatchers: ["CE5P", "Ender-5 Plus", "Ender 5 Plus", "Creality Ender", "Cura_SteamEngine"],
    extruders: 1,
  },
];

export function normalizePrinters(printers) {
  const incoming = Array.isArray(printers) && printers.length ? printers : DEFAULT_PRINTERS;
  return incoming.map((printer, index) => ({
    ...mergeDefaultPrinter(printer, index),
  }));
}

function mergeDefaultPrinter(printer, index) {
  const defaultPrinter = DEFAULT_PRINTERS.find((item) => item.id === printer.id) || {};
  return {
    ...defaultPrinter,
    ...printer,
    id: printer.id || `printer-${index + 1}`,
    name: printer.name || defaultPrinter.name || `Printer ${index + 1}`,
    modelMatchers: [...new Set([...(defaultPrinter.modelMatchers || []), ...(printer.modelMatchers || [])])],
    extruders: Number(printer.extruders || defaultPrinter.extruders) || 1,
  };
}

export function detectPrinterId(metadata = {}, fileName = "", printers = DEFAULT_PRINTERS) {
  const haystack = [
    metadata.printer_model,
    metadata.printer_settings_id,
    metadata.printer_notes,
    metadata.machine_name,
    metadata.generated_by,
    metadata.generated_with,
    metadata.flavor,
    fileName,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  const match = normalizePrinters(printers).find((printer) =>
    printer.modelMatchers.some((matcher) => haystack.includes(String(matcher).toLowerCase()))
  );

  if (match) return match.id;
  if (/\.(gcode|gco|gc)$/i.test(fileName)) return "ender-5-plus";
  return "";
}

export function printerName(printers, printerId) {
  return normalizePrinters(printers).find((printer) => printer.id === printerId)?.name || "Unassigned";
}
