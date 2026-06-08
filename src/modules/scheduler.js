import { detectPrinterId } from "./printers.js";

export function buildSchedule(jobs, settings, printers = []) {
  const printerStates = printers.map((printer) => ({
    id: printer.id,
    name: printer.name,
    availableAt: startDate(settings),
  }));

  const scheduledJobs = jobs
    .filter((job) => job.status !== "done")
    .sort((a, b) => deadlineSort(a, b, settings.deadline))
    .map((job) => {
      const jobPrinterId =
        job.printerId || detectPrinterId(job.metadata, `${job.fileName || ""} ${job.name || ""}`, printers);
      const eligiblePrinters = jobPrinterId
        ? printerStates.filter((printer) => printer.id === jobPrinterId)
        : printerStates;
      const printer = (eligiblePrinters.length ? eligiblePrinters : printerStates).sort(
        (a, b) => a.availableAt - b.availableAt
      )[0];
      const start = fitToChangeoverWindow(printer.availableAt, settings);
      const end = new Date(start.getTime() + (job.durationMinutes || 0) * 60000);
      printer.availableAt = settings.allowOvernight ? end : fitToWindow(end, settings);
      return {
        jobId: job.id,
        name: job.name,
        printerId: printer.id,
        printer: printer.name,
        start: start.toISOString(),
        end: end.toISOString(),
        durationMinutes: job.durationMinutes || 0,
      };
    });

  return {
    jobs: scheduledJobs,
    utilizationMinutes: scheduledJobs.reduce((sum, job) => sum + job.durationMinutes, 0),
  };
}

function deadlineSort(a, b, fallback) {
  return new Date(a.deadline || fallback) - new Date(b.deadline || fallback);
}

function startDate(settings) {
  const now = new Date();
  const [hours, minutes] = String(settings.changeoverStart || settings.dayStart || "08:00").split(":").map(Number);
  now.setHours(hours || 8, minutes || 0, 0, 0);
  return fitToChangeoverWindow(now, settings);
}

function fitToWindow(date, settings) {
  if (settings.allowOvernight) return date;
  const next = new Date(date);
  const [startHour, startMinute] = String(settings.dayStart || "08:00").split(":").map(Number);
  const [endHour, endMinute] = String(settings.dayEnd || "18:00").split(":").map(Number);
  const start = new Date(next);
  start.setHours(startHour || 8, startMinute || 0, 0, 0);
  const end = new Date(next);
  end.setHours(endHour || 18, endMinute || 0, 0, 0);

  if (next < start) return start;
  if (next > end) {
    next.setDate(next.getDate() + 1);
    next.setHours(startHour || 8, startMinute || 0, 0, 0);
  }
  return next;
}

function fitToChangeoverWindow(date, settings) {
  const next = new Date(date);
  const [startHour, startMinute] = String(settings.changeoverStart || settings.dayStart || "08:00")
    .split(":")
    .map(Number);
  const [endHour, endMinute] = String(settings.changeoverEnd || settings.dayEnd || "18:00")
    .split(":")
    .map(Number);
  const start = new Date(next);
  start.setHours(startHour || 8, startMinute || 0, 0, 0);
  const end = new Date(next);
  end.setHours(endHour || 18, endMinute || 0, 0, 0);

  if (next < start) return start;
  if (next > end) {
    next.setDate(next.getDate() + 1);
    next.setHours(startHour || 8, startMinute || 0, 0, 0);
  }
  return next;
}
