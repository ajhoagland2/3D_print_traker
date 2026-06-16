import { detectPrinterId } from "./printers.js";

export const SCHEDULE_VIEWS = ["month", "week", "timeline"];

export function defaultServicerAvailability() {
  return [1, 2, 3, 4, 5].map((day) => ({
    id: `servicer-${day}`,
    day_of_week: day,
    start_time: "08:00",
    end_time: "17:00",
    is_available: true,
    notes: "",
  }));
}

export function defaultChangeoverRules() {
  return {
    id: "default-changeover",
    default_changeover_minutes: 30,
    material_changeover_minutes: 45,
    color_changeover_minutes: 30,
    removal_required_minutes: 15,
    setup_required_minutes: 15,
    auto_complete_after_start: true,
  };
}

export function normalizeScheduleState(state) {
  return {
    ...state,
    scheduledJobs: Array.isArray(state.scheduledJobs) ? state.scheduledJobs : [],
    servicerAvailability: normalizeServicerAvailability(state.servicerAvailability),
    changeoverRules: normalizeChangeoverRules(state.changeoverRules),
    printerAvailability: Array.isArray(state.printerAvailability) ? state.printerAvailability : [],
    scheduleBlocks: Array.isArray(state.scheduleBlocks) ? state.scheduleBlocks : [],
  };
}

export function buildScheduleCalendar(state) {
  const monthStart = startOfMonth(state.settings.scheduleMonth || todayMonth());
  const monthEnd = addMonths(monthStart, 1);
  const visibleStart = state.settings.scheduleView === "week" ? startOfWeek(state.settings.scheduleWeek || monthStart) : monthStart;
  const visibleEnd = state.settings.scheduleView === "week" ? addDays(visibleStart, 7) : monthEnd;
  const visibleBlocks = state.scheduleBlocks.filter((block) => overlaps(block.start_time, block.end_time, visibleStart, visibleEnd));
  const visibleJobs = state.scheduledJobs.filter((job) =>
    overlaps(job.scheduled_start, job.scheduled_finish, visibleStart, visibleEnd)
  );

  return {
    monthStart,
    monthEnd,
    visibleStart,
    visibleEnd,
    days: daysBetween(visibleStart, visibleEnd),
    jobs: visibleJobs,
    blocks: visibleBlocks,
    warnings: scheduleWarnings(state, visibleStart, visibleEnd),
    summaries: scheduleSummaries(state, monthStart, monthEnd),
  };
}

export function commitQueuedJobsToSchedule(state, options) {
  const jobIds = new Set(options.jobIds || []);
  const queuedJobs = state.jobs.filter((job) => jobIds.has(job.id) && job.status === "queued");
  const warnings = [];
  if (!queuedJobs.length) return { state, warnings: ["Select at least one queued job to schedule."] };

  const targetWeek = startOfWeek(options.targetWeek || state.settings.scheduleWeek || new Date());
  const weekEnd = addDays(targetWeek, 7);
  const preferredStart = options.preferredStart ? new Date(options.preferredStart) : targetWeek;
  const existingBlocks = [...state.scheduleBlocks];
  const existingScheduledJobs = [...state.scheduledJobs];
  const printerCursors = Object.fromEntries(state.printers.map((printer) => [printer.id, new Date(Math.max(targetWeek, preferredStart))]));
  const servicerBlocks = existingBlocks.filter((block) => block.block_type === "Changeover");
  const scheduledJobIds = new Set();

  const newJobs = [];
  const newBlocks = [];

  for (const job of queuedJobs.sort((a, b) => prioritySort(options.priority, a, b))) {
    const printerId = options.printerId || job.printerId || detectPrinterId(job.metadata, `${job.fileName || ""} ${job.name || ""}`, state.printers);
    const printer = state.printers.find((item) => item.id === printerId);
    if (!printer) {
      warnings.push(`${job.name}: No compatible printer available.`);
      continue;
    }
    if (printer.disabled) {
      warnings.push(`${job.name}: Printer is disabled.`);
      continue;
    }

    const durationMinutes = Math.max(1, Number(job.durationMinutes) || 0);
    let cursor = maxDate(printerCursors[printer.id] || targetWeek, targetWeek, preferredStart);
    const printerBlocks = [...existingBlocks, ...newBlocks].filter((block) => block.printer_id === printer.id);
    const needsChangeover = printerBlocks.some((block) => block.block_type === "Print");
    let changeoverBlock = null;

    if (needsChangeover) {
      const changeoverMinutes = changeoverMinutesForJob(job, state.changeoverRules);
      const serviceStart = findServicerStart(cursor, changeoverMinutes, state.servicerAvailability, servicerBlocks);
      if (!serviceStart || serviceStart >= weekEnd) {
        warnings.push(`${job.name}: Changeover blocked by servicer availability.`);
        continue;
      }
      const serviceEnd = addMinutes(serviceStart, changeoverMinutes);
      changeoverBlock = createBlock({
        printerId: printer.id,
        blockType: "Changeover",
        start: serviceStart,
        end: serviceEnd,
        label: `${printer.name} changeover`,
        notes: "Setup, removal, inspection, and restart preparation.",
      });
      servicerBlocks.push(changeoverBlock);
      cursor = serviceEnd;
    }

    const start = findPrinterStart(cursor, durationMinutes, printerBlocks, targetWeek, weekEnd);
    const finish = addMinutes(start, durationMinutes);
    if (finish > weekEnd) {
      warnings.push(`${job.name}: Job does not fit in selected week.`);
      continue;
    }

    const scheduledJob = {
      id: crypto.randomUUID(),
      print_job_id: job.id,
      printer_id: printer.id,
      queue_id: job.id,
      scheduled_start: start.toISOString(),
      scheduled_finish: finish.toISOString(),
      estimated_duration_minutes: durationMinutes,
      material: primaryMaterial(job),
      color: job.color || "",
      status: "scheduled",
      priority: options.priority || "normal",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    const printBlock = createBlock({
      printerId: printer.id,
      blockType: "Print",
      relatedJobId: scheduledJob.id,
      start,
      end: finish,
      label: job.name,
      notes: `${primaryMaterial(job)} ${durationMinutes} minutes`,
    });

    if (changeoverBlock) newBlocks.push({ ...changeoverBlock, related_job_id: scheduledJob.id });
    newBlocks.push(printBlock);
    newJobs.push(scheduledJob);
    scheduledJobIds.add(job.id);
    printerCursors[printer.id] = finish;
  }

  const nextState = {
    ...state,
    jobs: state.jobs.map((job) => (scheduledJobIds.has(job.id) ? { ...job, status: "scheduled" } : job)),
    scheduledJobs: [...existingScheduledJobs, ...newJobs],
    scheduleBlocks: [...existingBlocks, ...newBlocks],
    settings: {
      ...state.settings,
      scheduleWeek: targetWeek.toISOString().slice(0, 10),
      scheduleMonth: targetWeek.toISOString().slice(0, 7),
    },
  };

  if (queuedJobs.length > newJobs.length) warnings.push("Some queued jobs were left unscheduled.");
  return { state: nextState, warnings };
}

export function updateScheduledJobStatus(state, scheduledJobId, status) {
  const scheduledJob = state.scheduledJobs.find((job) => job.id === scheduledJobId);
  if (!scheduledJob) return state;
  const now = new Date();
  const expectedFinish =
    status === "printing"
      ? addMinutes(now, Math.max(1, Number(scheduledJob.estimated_duration_minutes) || 0)).toISOString()
      : scheduledJob.expected_finish_at;
  return {
    ...state,
    jobs: state.jobs.map((job) =>
      job.id === scheduledJob.print_job_id ? { ...job, status: status === "printing" ? "printing" : status } : job
    ),
    scheduledJobs: state.scheduledJobs.map((job) =>
      job.id === scheduledJobId
        ? {
            ...job,
            status,
            actual_start_at: status === "printing" ? now.toISOString() : job.actual_start_at,
            expected_finish_at: expectedFinish,
            updated_at: now.toISOString(),
          }
        : job
    ),
  };
}

export function completeElapsedPrintingJobs(state, now = new Date()) {
  if (state.changeoverRules?.auto_complete_after_start === false) return state;
  const completed = state.scheduledJobs.filter(
    (job) => job.status === "printing" && job.expected_finish_at && new Date(job.expected_finish_at) <= now
  );
  if (!completed.length) return state;

  const completedScheduleIds = new Set(completed.map((job) => job.id));
  const completedPrintJobIds = new Set(completed.map((job) => job.print_job_id));

  return {
    ...state,
    jobs: state.jobs.map((job) =>
      completedPrintJobIds.has(job.id)
        ? { ...job, status: "completed", completedAt: now.toISOString(), updatedAt: now.toISOString() }
        : job
    ),
    scheduledJobs: state.scheduledJobs.filter((job) => !completedScheduleIds.has(job.id)),
    scheduleBlocks: state.scheduleBlocks.filter((block) => !completedScheduleIds.has(block.related_job_id)),
  };
}

export function unscheduleJob(state, scheduledJobId) {
  const scheduledJob = state.scheduledJobs.find((job) => job.id === scheduledJobId);
  if (!scheduledJob) return state;
  return {
    ...state,
    jobs: state.jobs.map((job) => (job.id === scheduledJob.print_job_id ? { ...job, status: "queued" } : job)),
    scheduledJobs: state.scheduledJobs.filter((job) => job.id !== scheduledJobId),
    scheduleBlocks: state.scheduleBlocks.filter((block) => block.related_job_id !== scheduledJobId),
  };
}

function normalizeServicerAvailability(availability) {
  const incoming = Array.isArray(availability) && availability.length ? availability : defaultServicerAvailability();
  return incoming.map((window, index) => ({
    id: window.id || `servicer-${index}`,
    day_of_week: Number(window.day_of_week),
    start_time: window.start_time || "08:00",
    end_time: window.end_time || "17:00",
    is_available: window.is_available !== false,
    notes: window.notes || "",
  }));
}

function normalizeChangeoverRules(rules = {}) {
  return {
    ...defaultChangeoverRules(),
    ...rules,
    default_changeover_minutes: Number(rules.default_changeover_minutes) || 30,
    material_changeover_minutes: Number(rules.material_changeover_minutes) || 45,
    color_changeover_minutes: Number(rules.color_changeover_minutes) || 30,
    removal_required_minutes: Number(rules.removal_required_minutes) || 15,
    setup_required_minutes: Number(rules.setup_required_minutes) || 15,
    auto_complete_after_start: rules.auto_complete_after_start !== false,
  };
}

function prioritySort(priority, a, b) {
  if (priority === "deadline") return new Date(a.deadline || "2999-12-31") - new Date(b.deadline || "2999-12-31");
  return (b.durationMinutes || 0) - (a.durationMinutes || 0);
}

function createBlock({ printerId, blockType, relatedJobId = "", start, end, label, notes = "" }) {
  return {
    id: crypto.randomUUID(),
    printer_id: printerId,
    block_type: blockType,
    related_job_id: relatedJobId,
    start_time: start.toISOString(),
    end_time: end.toISOString(),
    label,
    notes,
  };
}

function changeoverMinutesForJob(job, rules) {
  const materialCount = Object.keys(job.materials || {}).length;
  return materialCount > 1 ? rules.material_changeover_minutes : rules.default_changeover_minutes;
}

function findPrinterStart(cursor, durationMinutes, blocks, rangeStart, rangeEnd) {
  let start = maxDate(cursor, rangeStart);
  const sortedBlocks = blocks
    .filter((block) => overlaps(block.start_time, block.end_time, rangeStart, rangeEnd))
    .sort((a, b) => new Date(a.start_time) - new Date(b.start_time));

  for (const block of sortedBlocks) {
    const blockStart = new Date(block.start_time);
    const blockEnd = new Date(block.end_time);
    const finish = addMinutes(start, durationMinutes);
    if (finish <= blockStart) return start;
    if (start < blockEnd) start = blockEnd;
  }
  return start;
}

function findServicerStart(cursor, durationMinutes, availability, existingBlocks) {
  let probe = new Date(cursor);
  for (let attempt = 0; attempt < 28; attempt += 1) {
    const windows = availabilityWindowsForDate(probe, availability);
    for (const window of windows) {
      let start = maxDate(probe, window.start);
      const finish = addMinutes(start, durationMinutes);
      if (finish <= window.end && !existingBlocks.some((block) => overlaps(start, finish, block.start_time, block.end_time))) {
        return start;
      }
    }
    probe = addDays(startOfDay(probe), 1);
  }
  return null;
}

export function availabilityWindowsForDate(date, availability) {
  const day = new Date(date).getDay();
  return availability
    .filter((window) => window.is_available && Number(window.day_of_week) === day)
    .map((window) => ({
      start: applyTime(date, window.start_time),
      end: applyTime(date, window.end_time),
      label: window.notes || "Servicer available",
    }))
    .filter((window) => window.end > window.start);
}

function scheduleWarnings(state, visibleStart, visibleEnd) {
  const warnings = [];
  const scheduledIds = new Set(state.scheduledJobs.map((job) => job.print_job_id));
  const queued = state.jobs.filter((job) => job.status === "queued" && !scheduledIds.has(job.id));
  if (queued.length) warnings.push(`${queued.length} queued job${queued.length === 1 ? "" : "s"} waiting to be scheduled.`);
  for (const printer of state.printers) {
    const blocks = state.scheduleBlocks.filter((block) => block.printer_id === printer.id && overlaps(block.start_time, block.end_time, visibleStart, visibleEnd));
    if (blocksOverlap(blocks)) warnings.push(`${printer.name}: Printer overloaded.`);
  }
  return warnings;
}

function scheduleSummaries(state, monthStart, monthEnd) {
  const monthBlocks = state.scheduleBlocks.filter((block) => overlaps(block.start_time, block.end_time, monthStart, monthEnd));
  const printMinutes = totalMinutes(monthBlocks.filter((block) => block.block_type === "Print"));
  const changeoverMinutes = totalMinutes(monthBlocks.filter((block) => block.block_type === "Changeover"));
  const availableMinutes = state.printers.length * Math.round((monthEnd - monthStart) / 60000);
  const materialByMonth = {};
  const materialByWeek = {};
  let filamentCostMonth = 0;

  for (const scheduledJob of state.scheduledJobs.filter((job) => overlaps(job.scheduled_start, job.scheduled_finish, monthStart, monthEnd))) {
    const sourceJob = state.jobs.find((job) => job.id === scheduledJob.print_job_id);
    const weekKey = startOfWeek(scheduledJob.scheduled_start).toISOString().slice(0, 10);
    for (const [material, grams] of Object.entries(sourceJob?.materials || {})) {
      materialByMonth[material] = (materialByMonth[material] || 0) + grams;
      materialByWeek[weekKey] = materialByWeek[weekKey] || {};
      materialByWeek[weekKey][material] = (materialByWeek[weekKey][material] || 0) + grams;
      filamentCostMonth += estimateMaterialCost(state.inventory, material, grams);
    }
  }

  return {
    printMinutes,
    changeoverMinutes,
    availableMinutes,
    idleMinutes: Math.max(0, availableMinutes - printMinutes - changeoverMinutes),
    utilization: availableMinutes ? (printMinutes / availableMinutes) * 100 : 0,
    materialByMonth,
    materialByWeek,
    filamentCostMonth,
  };
}

function estimateMaterialCost(inventory, material, grams) {
  const item = inventory.find((spool) => spool.material === material && spool.costPerGram);
  return (item?.costPerGram || 0) * grams;
}

function totalMinutes(blocks) {
  return blocks.reduce((sum, block) => sum + Math.max(0, Math.round((new Date(block.end_time) - new Date(block.start_time)) / 60000)), 0);
}

function blocksOverlap(blocks) {
  const sorted = [...blocks].sort((a, b) => new Date(a.start_time) - new Date(b.start_time));
  return sorted.some((block, index) => index > 0 && new Date(block.start_time) < new Date(sorted[index - 1].end_time));
}

function primaryMaterial(job) {
  return Object.keys(job.materials || {})[0] || job.materialUses?.[0]?.material || "PLA";
}

function overlaps(startA, endA, startB, endB) {
  return new Date(startA) < new Date(endB) && new Date(endA) > new Date(startB);
}

export function startOfWeek(value) {
  const date = startOfDay(value);
  const day = date.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  date.setDate(date.getDate() + diff);
  return date;
}

function startOfMonth(value) {
  const date = value ? new Date(`${String(value).slice(0, 7)}-01T00:00:00`) : new Date();
  date.setDate(1);
  date.setHours(0, 0, 0, 0);
  return date;
}

function startOfDay(value) {
  const date = parseDate(value);
  date.setHours(0, 0, 0, 0);
  return date;
}

function parseDate(value) {
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return new Date(`${value}T00:00:00`);
  }
  return new Date(value);
}

function applyTime(date, time) {
  const [hours, minutes] = String(time || "00:00").split(":").map(Number);
  const next = new Date(date);
  next.setHours(hours || 0, minutes || 0, 0, 0);
  return next;
}

function addMinutes(date, minutes) {
  return new Date(new Date(date).getTime() + minutes * 60000);
}

function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function addMonths(date, months) {
  const next = new Date(date);
  next.setMonth(next.getMonth() + months);
  return next;
}

function daysBetween(start, end) {
  const days = [];
  for (let cursor = startOfDay(start); cursor < end; cursor = addDays(cursor, 1)) days.push(new Date(cursor));
  return days;
}

function maxDate(...dates) {
  return new Date(Math.max(...dates.map((date) => new Date(date).getTime())));
}

function todayMonth() {
  return new Date().toISOString().slice(0, 7);
}
