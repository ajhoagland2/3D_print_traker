import { aggregateRequiredMaterials } from "./costing.js";
import { materialTotals } from "./inventory.js";

export const PRODUCTION_STATUSES = [
  "staged",
  "queued",
  "scheduled",
  "printing",
  "paused",
  "failed",
  "waiting-material",
  "waiting-removal",
  "needs-inspection",
  "reprint-required",
  "post-processing",
  "ready-pickup",
  "completed",
];

const ACTIVE_STATUSES = new Set([
  "staged",
  "queued",
  "scheduled",
  "printing",
  "paused",
  "failed",
  "waiting-material",
  "waiting-removal",
  "needs-inspection",
  "reprint-required",
  "post-processing",
  "ready-pickup",
]);

export function normalizeProductionStatus(status, fallback = "queued") {
  const legacy = {
    done: "completed",
    blocked: "waiting-material",
    waiting_for_material: "waiting-material",
    waiting_for_removal: "waiting-removal",
    needs_inspection: "needs-inspection",
    reprint_required: "reprint-required",
    post_processing: "post-processing",
    ready_for_pickup: "ready-pickup",
  };
  const normalized =
    legacy[status] ||
    String(status || fallback)
      .trim()
      .toLowerCase()
      .replace(/[\s_]+/g, "-");
  return PRODUCTION_STATUSES.includes(normalized) ? normalized : fallback;
}

export function isActiveProductionStatus(status) {
  return ACTIVE_STATUSES.has(normalizeProductionStatus(status));
}

export function calculateAvailableMachineHours(printer, printerAvailability, targetWeek) {
  const explicit = (printerAvailability || []).filter((window) => window.printer_id === printer.id);
  const weekStart = startOfWeek(targetWeek);
  const weekEnd = addDays(weekStart, 7);

  if (explicit.length) {
    return explicit
      .filter((window) => overlaps(window.start_time, window.end_time, weekStart, weekEnd))
      .reduce((total, window) => total + hoursBetween(window.start_time, window.end_time), 0);
  }

  // Simplified default: a printer is assumed available all week until explicit availability exists.
  return printer.disabled ? 0 : 24 * 7;
}

export function calculatePrinterUtilization(printer, scheduledJobs, scheduleBlocks, targetWeek, printerAvailability = []) {
  const weekStart = startOfWeek(targetWeek);
  const weekEnd = addDays(weekStart, 7);
  const printHours = sumBlockHours(scheduleBlocks, printer.id, "Print", weekStart, weekEnd);
  const changeoverHours = sumBlockHours(scheduleBlocks, printer.id, "Changeover", weekStart, weekEnd);
  const availableHours = calculateAvailableMachineHours(printer, printerAvailability, weekStart);
  const scheduledHours = printHours + changeoverHours;
  const utilization = availableHours ? (printHours / availableHours) * 100 : 0;

  return {
    printerId: printer.id,
    availableHours,
    printHours,
    changeoverHours,
    scheduledHours,
    idleHours: Math.max(0, availableHours - scheduledHours),
    utilization,
    overloaded: scheduledHours > availableHours,
    underutilized: availableHours > 0 && utilization < 35,
  };
}

export function calculateIdleHours(printer, scheduledJobs, printerAvailability, targetWeek, scheduleBlocks = []) {
  return calculatePrinterUtilization(printer, scheduledJobs, scheduleBlocks, targetWeek, printerAvailability).idleHours;
}

export function getPrinterStatus(printer, jobs, scheduledJobs, scheduleBlocks, targetWeek, printerAvailability = [], inventory = []) {
  const now = new Date();
  const utilization = calculatePrinterUtilization(printer, scheduledJobs, scheduleBlocks, targetWeek, printerAvailability);
  const printerScheduledJobs = scheduledJobs
    .filter((job) => job.printer_id === printer.id)
    .sort((a, b) => new Date(a.scheduled_start) - new Date(b.scheduled_start));
  const running = printerScheduledJobs.find((job) => job.status === "printing");
  const currentScheduled = printerScheduledJobs.find((job) => new Date(job.scheduled_start) <= now && new Date(job.scheduled_finish) >= now);
  const nextScheduled = printerScheduledJobs.find((job) => new Date(job.scheduled_start) > now);
  const currentJob = running || currentScheduled;
  const sourceJob = jobs.find((job) => job.id === currentJob?.print_job_id);
  const nextJob = jobs.find((job) => job.id === nextScheduled?.print_job_id);
  const queuedForPrinter = jobs.filter((job) => job.status === "queued" && job.printerId === printer.id);

  let status = "Idle";
  if (printer.disabled) status = "Maintenance";
  else if (sourceJob?.status === "waiting-material") status = "Waiting for Material";
  else if (sourceJob?.status === "waiting-removal") status = "Waiting for Removal";
  else if (sourceJob?.status === "paused") status = "Paused";
  else if (sourceJob?.status === "failed") status = "Failed";
  else if (currentJob?.status === "printing") status = "Running";
  else if (currentJob || nextScheduled || queuedForPrinter.length) status = "Scheduled";

  const riskLabel = utilization.overloaded
    ? "Overloaded"
    : utilization.underutilized
      ? "Underutilized"
      : queuedForPrinter.some((job) => hasMaterialShortage(job, jobs, inventory))
        ? "Material risk"
        : "Balanced";

  return {
    printer,
    status,
    currentJobName: sourceJob?.name || "",
    nextJobName: nextJob?.name || "",
    riskLabel,
    ...utilization,
  };
}

export function calculateJobSlack(job, scheduledJobs) {
  const due = job.deadline ? endOfDay(job.deadline) : null;
  if (!due) return null;
  const scheduled = scheduledJobs.find((item) => item.print_job_id === job.id);
  const finish = scheduled?.scheduled_finish ? new Date(scheduled.scheduled_finish) : estimateUnscheduledCompletion(job);
  return Math.round((due - finish) / 3600000);
}

export function getJobRiskStatus(job, scheduledJobs, inventory, printerAvailability, printers = []) {
  const scheduled = scheduledJobs.find((item) => item.print_job_id === job.id);
  const slackHours = calculateJobSlack(job, scheduledJobs);
  const blockers = [];
  const materialShortage = hasMaterialShortage(job, [job], inventory);
  if (materialShortage) blockers.push("Material shortage");
  if (!job.printerId && !scheduled?.printer_id) blockers.push("No assigned printer");
  if (job.status === "failed") blockers.push("Print failed");
  if (job.status === "paused") blockers.push("Paused");
  if (job.status === "waiting-removal") blockers.push("Waiting for removal");
  if (job.status === "waiting-material") blockers.push("Waiting for material");
  if (!scheduled && job.deadline) blockers.push("Unscheduled with due date");

  let status = "on-track";
  if (blockers.length) status = "blocked";
  else if (slackHours !== null && slackHours < 0) status = "late";
  else if (slackHours !== null && slackHours <= 24) status = "at-risk";

  const printerId = scheduled?.printer_id || job.printerId || "";
  const printer = printers.find((item) => item.id === printerId);

  return {
    job,
    status,
    dueDate: job.deadline || "",
    estimatedCompletion: scheduled?.scheduled_finish || "",
    slackHours,
    assignedPrinter: printer?.name || (printerId ? printerId : "Unassigned"),
    blockingReason: blockers.join(", "),
  };
}

export function groupLeadTimeRisks(jobs, scheduledJobs, inventory, printerAvailability, printers = []) {
  const groups = { late: [], "at-risk": [], "on-track": [], blocked: [] };
  jobs
    .filter((job) => isActiveProductionStatus(job.status))
    .map((job) => getJobRiskStatus(job, scheduledJobs, inventory, printerAvailability, printers))
    .forEach((risk) => groups[risk.status].push(risk));
  return groups;
}

export function diagnoseBottlenecks(printers, jobs, scheduledJobs, inventory, scheduleBlocks, targetWeek, printerAvailability = []) {
  const weekStart = startOfWeek(targetWeek);
  const weekEnd = addDays(weekStart, 7);
  const diagnostics = [];
  const printerMetrics = printers.map((printer) =>
    calculatePrinterUtilization(printer, scheduledJobs, scheduleBlocks, weekStart, printerAvailability)
  );

  for (const metric of printerMetrics) {
    const printer = printers.find((item) => item.id === metric.printerId);
    if (metric.overloaded) diagnostics.push(`${printer.name} is overloaded next week.`);
    if (metric.idleHours >= 24) diagnostics.push(`${printer.name} has ${Math.round(metric.idleHours)} idle hours this week.`);
  }

  const changeoverHours = printerMetrics.reduce((total, metric) => total + metric.changeoverHours, 0);
  const scheduledHours = printerMetrics.reduce((total, metric) => total + metric.scheduledHours, 0);
  if (scheduledHours && changeoverHours / scheduledHours >= 0.15) {
    diagnostics.push(`Changeovers are consuming ${Math.round((changeoverHours / scheduledHours) * 100)}% of scheduled capacity.`);
  }

  const dueQueued = jobs.filter((job) => job.status === "queued" && job.deadline && inRange(job.deadline, weekStart, weekEnd));
  if (dueQueued.length) diagnostics.push(`${dueQueued.length} jobs are unscheduled and due this week.`);

  const shortages = materialShortages(jobs.filter((job) => isActiveProductionStatus(job.status)), inventory);
  for (const [material, grams] of Object.entries(shortages)) {
    diagnostics.push(`${material} shortage expected before queued work is complete (${Math.ceil(grams)}g short).`);
  }

  if (!diagnostics.length) diagnostics.push("No major capacity or lead-time bottleneck detected for the selected week.");
  return diagnostics;
}

export function generateRecommendedActions(printers, jobs, scheduledJobs, inventory, targetWeek, scheduleBlocks = [], printerAvailability = []) {
  const actions = [];
  const riskGroups = groupLeadTimeRisks(jobs, scheduledJobs, inventory, printerAvailability, printers);
  const printerMetrics = printers.map((printer) =>
    calculatePrinterUtilization(printer, scheduledJobs, scheduleBlocks, targetWeek, printerAvailability)
  );
  const queued = jobs.filter((job) => job.status === "queued");
  const bestNext = [...queued].sort((a, b) => urgencyScore(b, scheduledJobs, inventory) - urgencyScore(a, scheduledJobs, inventory))[0];

  if (bestNext) actions.push(`Start planning ${bestNext.name} next${bestNext.printerId ? ` on ${printerName(printers, bestNext.printerId)}` : ""}.`);
  const idlePrinter = printerMetrics.find((metric) => metric.idleHours >= 24);
  if (idlePrinter && queued.length) actions.push(`Schedule queued jobs into ${printerName(printers, idlePrinter.printerId)} idle capacity this week.`);
  const overloaded = printerMetrics.find((metric) => metric.overloaded);
  if (overloaded) actions.push(`Review ${printerName(printers, overloaded.printerId)} because it is overloaded.`);
  const shortages = materialShortages(jobs.filter((job) => isActiveProductionStatus(job.status)), inventory);
  const firstShortage = Object.entries(shortages)[0];
  if (firstShortage) actions.push(`Buy ${Math.ceil(firstShortage[1] / 1000)} spool of ${firstShortage[0]} before the next scheduled shortage.`);
  const removal = scheduledJobs.find((job) => job.status === "waiting-removal");
  if (removal) actions.push(`Remove completed ${jobName(jobs, removal.print_job_id)} to free ${printerName(printers, removal.printer_id)}.`);
  if (riskGroups.late.length || riskGroups["at-risk"].length) actions.push("Re-sequence late and at-risk jobs before adding lower-priority work.");
  if (!actions.length) actions.push("Keep the current schedule; no immediate operator action is required.");
  return actions.slice(0, 6);
}

export function calculateCapacityHeatmap(printers, scheduledJobs, printerAvailability, targetWeek, scheduleBlocks = []) {
  const weekStart = startOfWeek(targetWeek);
  const days = Array.from({ length: 7 }, (_, index) => addDays(weekStart, index));
  return printers.map((printer) => ({
    printer,
    days: days.map((day) => {
      const dayEnd = addDays(day, 1);
      const availableHours = Math.min(24, calculateAvailableMachineHours(printer, printerAvailability, day));
      const printHours = sumBlockHours(scheduleBlocks, printer.id, "Print", day, dayEnd);
      const changeoverHours = sumBlockHours(scheduleBlocks, printer.id, "Changeover", day, dayEnd);
      const scheduledHours = printHours + changeoverHours;
      return {
        date: day,
        availableHours,
        scheduledHours,
        remainingHours: Math.max(0, availableHours - scheduledHours),
        utilization: availableHours ? (printHours / availableHours) * 100 : 0,
        overloaded: scheduledHours > availableHours,
      };
    }),
  }));
}

export function urgencyScore(job, scheduledJobs = [], inventory = []) {
  const slack = calculateJobSlack(job, scheduledJobs);
  let score = 0;
  if (slack !== null) score += Math.max(0, 120 - slack);
  score += priorityWeight(job.customerPriority);
  score += Math.min(40, Math.round((Number(job.durationMinutes) || 0) / 60));
  if (!job.printerId) score += 10;
  if (hasMaterialShortage(job, [job], inventory)) score += 25;
  return score;
}

function priorityWeight(priority) {
  return { rush: 80, high: 50, normal: 20, low: 0 }[priority] || 20;
}

function hasMaterialShortage(job, jobs, inventory) {
  return Object.keys(materialShortages([job], inventory)).length > 0;
}

function materialShortages(jobs, inventory) {
  const required = aggregateRequiredMaterials(jobs);
  const available = materialTotals(inventory);
  return Object.fromEntries(
    Object.entries(required)
      .map(([material, grams]) => [material, grams - (available[material] || 0)])
      .filter(([, shortage]) => shortage > 0)
  );
}

function sumBlockHours(blocks, printerId, blockType, start, end) {
  return (blocks || [])
    .filter((block) => block.printer_id === printerId && block.block_type === blockType && overlaps(block.start_time, block.end_time, start, end))
    .reduce((total, block) => total + clippedHours(block.start_time, block.end_time, start, end), 0);
}

function clippedHours(startValue, endValue, rangeStart, rangeEnd) {
  const start = new Date(Math.max(new Date(startValue), new Date(rangeStart)));
  const end = new Date(Math.min(new Date(endValue), new Date(rangeEnd)));
  return Math.max(0, (end - start) / 3600000);
}

function hoursBetween(startValue, endValue) {
  return Math.max(0, (new Date(endValue) - new Date(startValue)) / 3600000);
}

function estimateUnscheduledCompletion(job) {
  const created = job.createdAt ? new Date(job.createdAt) : new Date();
  return addHours(created, Math.max(1, Number(job.durationMinutes) / 60 || 24));
}

function inRange(value, start, end) {
  const date = new Date(`${String(value).slice(0, 10)}T12:00:00`);
  return date >= start && date < end;
}

function endOfDay(value) {
  const date = new Date(`${String(value).slice(0, 10)}T23:59:59`);
  return date;
}

function startOfWeek(value) {
  const date = startOfDay(value);
  const day = date.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  date.setDate(date.getDate() + diff);
  return date;
}

function startOfDay(value) {
  const date = new Date(value);
  date.setHours(0, 0, 0, 0);
  return date;
}

function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function addHours(date, hours) {
  return new Date(new Date(date).getTime() + hours * 3600000);
}

function overlaps(startA, endA, startB, endB) {
  return new Date(startA) < new Date(endB) && new Date(endA) > new Date(startB);
}

function printerName(printers, printerId) {
  return printers.find((printer) => printer.id === printerId)?.name || "Unassigned";
}

function jobName(jobs, jobId) {
  return jobs.find((job) => job.id === jobId)?.name || "scheduled job";
}
