export const MATERIALS = ["PLA", "PETG", "ASA", "ABS", "TPU", "Nylon", "PC", "Other"];
export const INVENTORY_STATUSES = ["ready", "reserve"];

export const DEFAULT_INVENTORY = [
  defaultSpool("prusa-xl-dual-t0-black", "prusa-xl-dual", "T0", "Black"),
  defaultSpool("prusa-xl-dual-t1-white", "prusa-xl-dual", "T1", "White"),
  defaultSpool("ender-5-plus-t0-black", "ender-5-plus", "T0", "Black"),
];

const PREFERRED_TOOL_COLORS = {
  "prusa-xl-dual:T0": "black",
  "prusa-xl-dual:T1": "white",
  "ender-5-plus:T0": "black",
};

export function createInventoryItem(formData) {
  const spoolWeight = toNumber(formData.get("spoolWeight"));
  const remainingWeight = toNumber(formData.get("remainingWeight"));
  const costPerSpool = toNumber(formData.get("costPerSpool"));
  const printerId = String(formData.get("printerId") || "");
  const status = printerId ? String(formData.get("status") || "ready") : "reserve";

  return {
    id: crypto.randomUUID(),
    product_id: "",
    barcode: normalizeBarcode(formData.get("barcode")),
    material: String(formData.get("material") || "PLA").trim().toUpperCase(),
    color: String(formData.get("color") || "").trim(),
    brand: String(formData.get("brand") || "").trim(),
    starting_weight: spoolWeight,
    spoolWeight,
    remaining_weight: remainingWeight,
    remainingWeight,
    cost: costPerSpool,
    costPerSpool,
    costPerGram: spoolWeight > 0 ? costPerSpool / spoolWeight : 0,
    storage_location: String(formData.get("location") || "").trim(),
    location: String(formData.get("location") || "").trim(),
    status,
    printerId,
    toolhead: String(formData.get("toolhead") || "T0"),
    date_added: new Date().toISOString(),
    notes: String(formData.get("notes") || "").trim(),
    updatedAt: new Date().toISOString(),
  };
}

export function createProduct(formData) {
  return {
    id: crypto.randomUUID(),
    barcode: normalizeBarcode(formData.get("barcode")),
    material: String(formData.get("material") || "PLA").trim().toUpperCase(),
    color: String(formData.get("color") || "").trim(),
    brand: String(formData.get("brand") || "").trim(),
    nominal_spool_weight: toNumber(formData.get("nominal_spool_weight") || formData.get("spoolWeight")),
    default_cost: toNumber(formData.get("default_cost") || formData.get("cost")),
    supplier: String(formData.get("supplier") || "").trim(),
    notes: String(formData.get("notes") || "").trim(),
  };
}

export function createInventorySpoolFromProduct(product, overrides = {}) {
  const startingWeight = toNumber(overrides.starting_weight ?? overrides.startingWeight ?? product.nominal_spool_weight);
  const remainingWeight = toNumber(overrides.remaining_weight ?? overrides.remainingWeight ?? startingWeight);
  const cost = toNumber(overrides.cost ?? product.default_cost);
  const storageLocation = String(overrides.storage_location ?? overrides.location ?? "").trim();

  return {
    id: crypto.randomUUID(),
    product_id: product.id,
    barcode: normalizeBarcode(product.barcode),
    material: product.material,
    color: product.color,
    brand: product.brand,
    starting_weight: startingWeight,
    spoolWeight: startingWeight,
    remaining_weight: remainingWeight,
    remainingWeight,
    cost,
    costPerSpool: cost,
    costPerGram: startingWeight > 0 ? cost / startingWeight : 0,
    storage_location: storageLocation,
    location: storageLocation,
    status: overrides.status || "reserve",
    date_added: new Date().toISOString(),
    notes: String(overrides.notes || "").trim(),
    printerId: overrides.printerId || "",
    toolhead: overrides.toolhead || "T0",
    updatedAt: new Date().toISOString(),
  };
}

export function findProductByBarcode(products, barcode) {
  const normalizedBarcode = normalizeBarcode(barcode);
  if (!normalizedBarcode) return null;
  return normalizeProducts(products).find((product) => product.barcode === normalizedBarcode) || null;
}

export function normalizeBarcode(value) {
  return String(value || "").trim();
}

export function normalizeProducts(products) {
  return (Array.isArray(products) ? products : [])
    .filter((product) => normalizeBarcode(product.barcode))
    .map((product) => ({
      id: product.id || crypto.randomUUID(),
      barcode: normalizeBarcode(product.barcode),
      material: String(product.material || "PLA").trim().toUpperCase(),
      color: product.color || "",
      brand: product.brand || "",
      nominal_spool_weight: toNumber(product.nominal_spool_weight || product.spoolWeight || 1000),
      default_cost: toNumber(product.default_cost || product.cost || product.costPerSpool),
      supplier: product.supplier || "",
      notes: product.notes || "",
    }));
}

export function normalizeInventory(inventory) {
  const incoming = Array.isArray(inventory) && inventory.length ? inventory : DEFAULT_INVENTORY;
  return incoming.map((item) => {
    const startingWeight = toNumber(item.starting_weight || item.spoolWeight || 1000);
    const remainingWeight = toNumber(item.remaining_weight || item.remainingWeight || startingWeight);
    const cost = toNumber(item.cost || item.costPerSpool);
    const location = item.storage_location || item.location || "";

    return {
      ...item,
      id: item.id || crypto.randomUUID(),
      product_id: item.product_id || "",
      barcode: normalizeBarcode(item.barcode),
      material: String(item.material || "PLA").toUpperCase(),
      color: item.color || "",
      brand: item.brand || "",
      starting_weight: startingWeight,
      spoolWeight: startingWeight,
      remaining_weight: remainingWeight,
      remainingWeight,
      cost,
      costPerSpool: cost,
      costPerGram: toNumber(item.costPerGram) || (startingWeight ? cost / startingWeight : 0),
      storage_location: location,
      location,
      status: item.printerId ? item.status || "ready" : item.status || "reserve",
      date_added: item.date_added || item.updatedAt || new Date().toISOString(),
      notes: item.notes || "",
      printerId: item.printerId || "",
      toolhead: item.toolhead || "T0",
      updatedAt: item.updatedAt || new Date().toISOString(),
    };
  });
}

export function autoAssignReadySpools(jobs, inventory, printers) {
  const assignedInventory = normalizeInventory(inventory).map((item) => ({ ...item }));
  const activeDemands = jobs
    .filter((job) => job.status !== "done" && job.printerId)
    .flatMap((job) =>
      jobDemands(job).map((demand) => ({
        ...demand,
        printerId: job.printerId,
      }))
    );

  for (const demand of activeDemands) {
    if (hasReadySpool(assignedInventory, demand)) continue;
    const reserveSpool = reserveCandidates(assignedInventory, demand)[0];

    if (!reserveSpool) continue;

    reserveSpool.status = "ready";
    reserveSpool.printerId = demand.printerId;
    reserveSpool.toolhead = demand.toolhead || "T0";
    reserveSpool.storage_location = "Auto-loaded";
    reserveSpool.location = "Auto-loaded";
    reserveSpool.updatedAt = new Date().toISOString();
  }

  return assignedInventory;
}

function reserveCandidates(inventory, demand) {
  const preferredColor = PREFERRED_TOOL_COLORS[`${demand.printerId}:${demand.toolhead || "T0"}`];
  return inventory
    .filter((item) => item.status === "reserve" && item.material === demand.material && item.remainingWeight > 0)
    .sort((a, b) => {
      const aPreferred = preferredColor && a.color.toLowerCase() === preferredColor ? 0 : 1;
      const bPreferred = preferredColor && b.color.toLowerCase() === preferredColor ? 0 : 1;
      return aPreferred - bPreferred || a.remainingWeight - b.remainingWeight;
    });
}

export function inventoryValue(inventory) {
  return inventory.reduce((total, item) => total + item.remainingWeight * item.costPerGram, 0);
}

export function materialTotals(inventory) {
  return inventory.reduce((totals, item) => {
    totals[item.material] = (totals[item.material] || 0) + item.remainingWeight;
    return totals;
  }, {});
}

export function inventoryWarnings(inventory, requiredByMaterial) {
  const available = materialTotals(inventory);
  const warnings = [];

  for (const [material, required] of Object.entries(requiredByMaterial)) {
    const remaining = available[material] || 0;
    if (remaining < required) {
      warnings.push({
        type: "shortage",
        material,
        message: `${material}: ${formatGrams(required - remaining)} short`,
      });
    }
  }

  for (const item of inventory) {
    if (item.remainingWeight <= Math.max(75, item.spoolWeight * 0.1)) {
      warnings.push({
        type: "low",
        material: item.material,
        message: `${item.material} ${item.color || ""} ${item.brand || ""}`.trim() + " is low",
      });
    }
  }

  return warnings;
}

export function consumeInventoryPreview(inventory, requiredByMaterial) {
  const remaining = inventory.map((item) => ({ ...item }));
  const allocations = {};

  for (const [material, grams] of Object.entries(requiredByMaterial)) {
    let need = grams;
    const spools = remaining
      .filter((item) => item.material === material)
      .sort((a, b) => a.remainingWeight - b.remainingWeight);

    for (const spool of spools) {
      if (need <= 0) break;
      const used = Math.min(spool.remainingWeight, need);
      spool.remainingWeight -= used;
      need -= used;
      allocations[material] = (allocations[material] || 0) + used;
    }
  }

  return { remaining, allocations };
}

export function forecastInventory(jobs, inventory, printers) {
  const remaining = normalizeInventory(inventory).map((item) => ({ ...item }));
  const consumption = [];
  const purchaseNeeds = {};

  for (const job of jobs.filter((item) => item.status !== "done")) {
    const demands = jobDemands(job);

    for (const demand of demands) {
      let need = demand.grams || 0;
      const allocation = {
        jobId: job.id,
        jobName: job.name,
        printerId: job.printerId || "",
        material: demand.material,
        toolhead: demand.toolhead || "T0",
        grams: demand.grams || 0,
        spools: [],
      };

      for (const spool of matchingSpools(remaining, allocation)) {
        if (need <= 0) break;
        const used = Math.min(spool.remainingWeight, need);
        spool.remainingWeight -= used;
        need -= used;
        allocation.spools.push({ spoolId: spool.id, used });
      }

      if (need > 0) {
        purchaseNeeds[demand.material] = (purchaseNeeds[demand.material] || 0) + need;
      }

      consumption.push({ ...allocation, shortage: Math.max(0, need) });
    }
  }

  return {
    remaining,
    consumption,
    purchaseNeeds,
    purchaseSpools: Object.fromEntries(
      Object.entries(purchaseNeeds).map(([material, grams]) => [material, Math.ceil(grams / 1000)])
    ),
  };
}

function jobDemands(job) {
  if (job.materialUses?.length) return job.materialUses;

  const materials = Object.entries(job.materials || {});
  const toolheads = Array.isArray(job.toolheads) && job.toolheads.length ? job.toolheads : ["T0"];

  if (materials.length === 1 && toolheads.length > 1) {
    const [material, grams] = materials[0];
    const gramsPerTool = grams / toolheads.length;
    return toolheads.map((toolhead) => ({
      material,
      grams: gramsPerTool,
      toolhead,
    }));
  }

  if (materials.length === toolheads.length) {
    return materials.map(([material, grams], index) => ({
      material,
      grams,
      toolhead: toolheads[index],
    }));
  }

  return materials.map(([material, grams]) => ({
    material,
    grams,
    toolhead: "T0",
  }));
}

function hasReadySpool(inventory, demand) {
  return inventory.some(
    (item) =>
      item.status === "ready" &&
      item.printerId === demand.printerId &&
      item.material === demand.material &&
      item.remainingWeight > 0 &&
      (!demand.toolhead || item.toolhead === demand.toolhead)
  );
}

function matchingSpools(inventory, demand) {
  const samePrinterReady = inventory.filter(
    (item) =>
      item.status === "ready" &&
      item.printerId === demand.printerId &&
      item.material === demand.material &&
      item.remainingWeight > 0 &&
      (!demand.toolhead || item.toolhead === demand.toolhead)
  );

  const samePrinterFallback = inventory.filter(
    (item) =>
      item.status === "ready" &&
      item.printerId === demand.printerId &&
      item.material === demand.material &&
      item.remainingWeight > 0 &&
      !samePrinterReady.includes(item)
  );

  const reserve = inventory.filter(
    (item) => item.status === "reserve" && item.material === demand.material && item.remainingWeight > 0
  );

  return [
    ...samePrinterReady.sort((a, b) => a.remainingWeight - b.remainingWeight),
    ...samePrinterFallback.sort((a, b) => a.remainingWeight - b.remainingWeight),
    ...reserve.sort((a, b) => a.remainingWeight - b.remainingWeight),
  ];
}

function defaultSpool(id, printerId, toolhead, color) {
  return {
    id,
    product_id: "",
    barcode: "",
    material: "PLA",
    color,
    brand: "Hatchbox",
    starting_weight: 1000,
    spoolWeight: 1000,
    remaining_weight: 1000,
    remainingWeight: 1000,
    cost: 0,
    costPerSpool: 0,
    costPerGram: 0,
    storage_location: "Loaded",
    location: "Loaded",
    status: "ready",
    printerId,
    toolhead,
    date_added: new Date().toISOString(),
    notes: "",
    updatedAt: new Date().toISOString(),
  };
}

function toNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function formatGrams(value) {
  return `${Math.ceil(value)}g`;
}
