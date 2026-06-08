import { inventoryValue, materialTotals } from "./inventory.js";

export function calculateProjectCosts(jobs, inventory) {
  const requiredByMaterial = aggregateRequiredMaterials(jobs);
  const availableByMaterial = materialTotals(inventory);
  const costByMaterial = {};

  for (const [material, grams] of Object.entries(requiredByMaterial)) {
    costByMaterial[material] = grams * averageCostPerGram(inventory, material);
  }

  const jobCosts = jobs.map((job) => ({
    jobId: job.id,
    cost: calculateJobCost(job, inventory),
  }));

  return {
    jobCosts,
    requiredByMaterial,
    availableByMaterial,
    costByMaterial,
    totalCost: Object.values(costByMaterial).reduce((sum, value) => sum + value, 0),
    remainingInventoryValue: inventoryValue(inventory),
  };
}

export function calculateJobCost(job, inventory) {
  return Object.entries(job.materials).reduce((sum, [material, grams]) => {
    return sum + grams * averageCostPerGram(inventory, material);
  }, 0);
}

export function aggregateRequiredMaterials(jobs) {
  return jobs.reduce((totals, job) => {
    for (const [material, grams] of Object.entries(job.materials)) {
      totals[material] = (totals[material] || 0) + grams;
    }
    return totals;
  }, {});
}

export function averageCostPerGram(inventory, material) {
  const matching = inventory.filter((item) => item.material === material && item.remainingWeight > 0);
  if (!matching.length) return 0;
  const totalWeight = matching.reduce((sum, item) => sum + item.remainingWeight, 0);
  const totalValue = matching.reduce((sum, item) => sum + item.remainingWeight * item.costPerGram, 0);
  return totalWeight > 0 ? totalValue / totalWeight : 0;
}
