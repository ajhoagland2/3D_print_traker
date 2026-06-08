export function buildSchedule(jobs, settings) {
  const printerCount = Math.max(1, Number(settings.printerCount) || 1);
  const deadline = deadlineDate(settings);
  const printers = Array.from({ length: printerCount }, (_, index) => ({
    id: `Printer ${index + 1}`,
    availableAt: nextOperatingStart(settings),
    jobs: [],
  }));

  const orderedJobs = recommendPrintOrder(jobs);

  for (const job of orderedJobs) {
    const printer = printers.sort((a, b) => a.availableAt - b.availableAt)[0];
    const start = alignToOperatingWindow(printer.availableAt, settings, job.durationMinutes);
    const end = new Date(start.getTime() + job.durationMinutes * 60 * 1000);
    printer.jobs.push({
      jobId: job.id,
      fileName: job.fileName,
      start,
      end,
      durationMinutes: job.durationMinutes,
      material: primaryMaterial(job),
      overnight: isOvernight(start, end),
    });
    printer.availableAt = end;
  }

  const scheduledJobs = printers.flatMap((printer) =>
    printer.jobs.map((job) => ({ ...job, printer: printer.id })),
  );
  const totalPrintMinutes = jobs.reduce((sum, job) => sum + job.durationMinutes, 0);
  const makespanMinutes = calculateMakespanMinutes(scheduledJobs);

  return {
    printers,
    scheduledJobs: scheduledJobs.sort((a, b) => a.start - b.start),
    utilization: makespanMinutes ? totalPrintMinutes / (makespanMinutes * printerCount) : 0,
    completionDate: scheduledJobs.length
      ? new Date(Math.max(...scheduledJobs.map((job) => job.end.getTime())))
      : null,
    deadline,
    deadlineRisk: deadline && scheduledJobs.length
      ? new Date(Math.max(...scheduledJobs.map((job) => job.end.getTime()))) > deadline
      : false,
  };
}

export function recommendPrintOrder(jobs) {
  return [...jobs].sort((a, b) => {
    const materialCompare = primaryMaterial(a).localeCompare(primaryMaterial(b));
    if (materialCompare !== 0) return materialCompare;
    return b.durationMinutes - a.durationMinutes;
  });
}

function alignToOperatingWindow(date, settings, durationMinutes) {
  if (settings.allowOvernight && durationMinutes >= 360) return new Date(date);

  const start = parseTime(settings.dayStart);
  const end = parseTime(settings.dayEnd);
  const candidate = new Date(date);
  const minutes = candidate.getHours() * 60 + candidate.getMinutes();

  if (minutes < start) {
    candidate.setHours(Math.floor(start / 60), start % 60, 0, 0);
  }

  if (minutes >= end || minutes + durationMinutes > end) {
    candidate.setDate(candidate.getDate() + 1);
    candidate.setHours(Math.floor(start / 60), start % 60, 0, 0);
  }

  return candidate;
}

function nextOperatingStart(settings) {
  const now = new Date();
  return alignToOperatingWindow(now, settings, 0);
}

function deadlineDate(settings) {
  if (!settings.deadline) return null;
  const date = new Date(`${settings.deadline}T23:59:59`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function parseTime(value) {
  const [hours, minutes] = String(value || "08:00").split(":").map(Number);
  return hours * 60 + minutes;
}

function primaryMaterial(job) {
  return Object.keys(job.materials)[0] || job.material || "PLA";
}

function isOvernight(start, end) {
  return start.toDateString() !== end.toDateString() || end.getHours() < start.getHours();
}

function calculateMakespanMinutes(scheduledJobs) {
  if (!scheduledJobs.length) return 0;
  const start = Math.min(...scheduledJobs.map((job) => job.start.getTime()));
  const end = Math.max(...scheduledJobs.map((job) => job.end.getTime()));
  return (end - start) / 60000;
}
