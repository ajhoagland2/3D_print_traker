export const MATERIALS = ["PLA", "PETG", "ASA", "ABS", "TPU", "Nylon", "PC", "Other"];

export function createInventoryItem(formData) {
  const spoolWeight = toNumber(formData.get("spoolWeight"));
  const remainingWeight = toNumber(formData.get("remainingWeight"));
  const costPerSpool = toNumber(formData.get("costPerSpool"));

  return {
    id: crypto.randomUUID(),
    material: String(formData.get("material") || "PLA").trim().toUpperCase(),
    color: String(formData.get("color") || "").trim(),
    brand: String(formData.get("brand") || "").trim(),
    spoolWeight,
    remainingWeight,
    costPerSpool,
    costPerGram: spoolWeight > 0 ? costPerSpool / spoolWeight : 0,
    location: String(formData.get("location") || "").trim(),
    updatedAt: new Date().toISOString(),
  };
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

function toNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function formatGrams(value) {
  return `${Math.ceil(value)}g`;
}
