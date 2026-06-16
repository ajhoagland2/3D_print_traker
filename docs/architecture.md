# Architecture

Artaic Print Planner is a static, local-first browser application for uploading G-code, tracking filament inventory, planning printer schedules, and monitoring scheduled production work. It runs entirely from `index.html` with JavaScript modules in `src/` and persists data in browser `localStorage`.

## Application Map

```mermaid
flowchart TD
  Browser["Browser opens index.html"] --> Main["src/main.js"]
  Main --> Load["loadState()"]
  Load --> Normalize["normalizeState()"]
  Normalize --> Render["renderApp(state, commit)"]

  Render --> JobsTab["Jobs tab"]
  Render --> InventoryTab["Inventory tab"]
  Render --> ScheduleTab["Schedule tab"]
  Render --> MaterialsTab["Materials tab"]
  Render --> Dashboard["Dashboard metrics"]

  JobsTab --> Upload["Upload G-code"]
  InventoryTab --> InventoryForms["Inventory and barcode intake"]
  ScheduleTab --> SchedulerUI["Calendar scheduler"]
  MaterialsTab --> ForecastUI["Material forecast"]

  Upload --> Commit["commit(nextState)"]
  InventoryForms --> Commit
  SchedulerUI --> Commit
  Commit --> Normalize
  Commit --> Save["saveState()"]
  Save --> LocalStorage["localStorage: artaic-print-planner-v1"]
  Normalize --> Render
```

## Module Responsibilities

```mermaid
flowchart LR
  Gcode["gcodeParser.js"] --> Jobs["Print jobs"]
  Printers["printers.js"] --> Jobs
  Inventory["inventory.js"] --> InventoryState["Inventory/products"]
  Costing["costing.js"] --> Costs["Costs and material demand"]
  Scheduler["scheduler.js"] --> Calendar["Scheduled jobs and blocks"]
  Storage["storage.js"] --> State["Normalized application state"]
  Render["ui/render.js"] --> DOM["DOM and event handlers"]

  Jobs --> Costing
  InventoryState --> Costing
  Jobs --> Scheduler
  InventoryState --> Scheduler
  State --> Render
  Costs --> Render
  Calendar --> Render
  Render --> Storage
```

- `src/main.js`: Starts the app, owns the `commit()` loop, and re-renders after every state change.
- `src/modules/storage.js`: Loads, saves, imports, exports, clears, and normalizes state.
- `src/modules/gcodeParser.js`: Parses uploaded `.gcode`, `.bgcode`, `.gco`, and `.gc` files into queued print jobs.
- `src/modules/printers.js`: Defines default printers and detects printer assignment from metadata or filenames.
- `src/modules/inventory.js`: Creates inventory/products, normalizes spool fields, handles barcode products, forecasts inventory, and produces material warnings.
- `src/modules/costing.js`: Calculates required material, available material, job costs, and material costs.
- `src/modules/scheduler.js`: Owns schedule models, monthly/weekly calendar building, queue-to-schedule commits, changeover placement, servicer availability, start/auto-complete behavior, and warnings.
- `src/ui/render.js`: Renders all tabs, dashboard metrics, forms, Gantt charts, warnings, and binds user events.
- `src/styles.css`: Provides all static styling for dashboard cards, queues, inventory, scheduler controls, Gantt lanes, and responsive behavior.

## State Shape

```mermaid
classDiagram
  class AppState {
    jobs[]
    products[]
    inventory[]
    printers[]
    scheduledJobs[]
    scheduleBlocks[]
    servicerAvailability[]
    changeoverRules
    printerAvailability[]
    settings
  }

  class PrintJob {
    id
    name
    fileName
    printerId
    materials
    durationMinutes
    toolheads
    metadata
    status
    createdAt
  }

  class ScheduledJob {
    id
    print_job_id
    printer_id
    queue_id
    scheduled_start
    scheduled_finish
    estimated_duration_minutes
    material
    color
    status
    priority
    actual_start_at
    expected_finish_at
  }

  class ScheduleBlock {
    id
    printer_id
    block_type
    related_job_id
    start_time
    end_time
    label
    notes
  }

  class ServicerAvailability {
    id
    day_of_week
    start_time
    end_time
    is_available
    notes
  }

  AppState "1" --> "*" PrintJob
  AppState "1" --> "*" ScheduledJob
  AppState "1" --> "*" ScheduleBlock
  AppState "1" --> "*" ServicerAvailability
```

The state is saved as JSON in `localStorage` under `artaic-print-planner-v1`. Import/export use the same normalized state shape.

## Render And Commit Loop

```mermaid
sequenceDiagram
  participant User
  participant UI as render.js
  participant Main as main.js
  participant Storage as storage.js
  participant Browser as localStorage

  User->>UI: Interacts with form/button/upload
  UI->>Main: commit(nextState)
  Main->>Storage: normalizeState(nextState)
  Storage->>Storage: normalize printers, jobs, inventory, schedule models
  Main->>Browser: saveState(normalizedState)
  Main->>UI: renderApp(normalizedState, commit)
```

The app does not use a framework. Each commit replaces rendered HTML and rebinds event listeners.

## G-code Upload Flow

```mermaid
flowchart TD
  Upload["User uploads G-code files"] --> Parser["parseGcodeFile(file)"]
  Parser --> Metadata["Extract metadata, duration, filament grams, materials, toolheads"]
  Metadata --> DetectPrinter["detectPrinterId(metadata, filename)"]
  DetectPrinter --> Job["Create PrintJob with status = queued"]
  Job --> JobsState["Append to state.jobs"]
  JobsState --> Normalize["normalizeState()"]
  Normalize --> Queues["Jobs tab queue columns"]
  Normalize --> Costs["Cost/material forecasts"]
```

Uploaded jobs start as `queued`. They are not scheduled or printed automatically.

## Inventory And Barcode Flow

```mermaid
flowchart TD
  InventoryForm["Manual inventory form"] --> CreateItem["createInventoryItem(formData)"]
  BarcodeScan["Barcode scanner form"] --> NormalizeBarcode["normalizeBarcode()"]
  NormalizeBarcode --> ProductLookup{"Product exists?"}
  ProductLookup -- Yes --> Spool["createInventorySpoolFromProduct(product)"]
  ProductLookup -- No --> AddProduct["Show product form"]
  AddProduct --> CreateProduct["createProduct(formData)"]
  CreateProduct --> Spool
  CreateItem --> InventoryState["state.inventory"]
  Spool --> InventoryState
  InventoryState --> Forecast["forecastInventory()"]
  Forecast --> InventoryUI["Inventory tab and material forecast"]
```

Barcode intake is local-only. Saved products make future scans create inventory spools immediately.

## Costing And Material Forecast Flow

```mermaid
flowchart LR
  Jobs["Queued/scheduled/printing jobs"] --> Required["aggregateRequiredMaterials()"]
  Inventory["Inventory spools"] --> AverageCost["averageCostPerGram()"]
  Required --> JobCost["calculateJobCost()"]
  AverageCost --> JobCost
  JobCost --> Dashboard["Dashboard material and cost metrics"]
  Required --> Forecast["forecastInventory()"]
  Inventory --> Forecast
  Forecast --> Warnings["Material warnings and purchase needs"]
```

Cost and forecast calculations are previews. The current app does not decrement physical inventory when a print completes.

## Scheduling Workflow

```mermaid
stateDiagram-v2
  [*] --> Queued: G-code upload
  Queued --> Scheduled: Commit selected queued jobs
  Scheduled --> Printing: User clicks Start
  Printing --> Completed: Auto-complete after estimated duration
  Scheduled --> Queued: Delete scheduled item
  Completed --> [*]
```

Committing jobs places them into the production calendar. It does not start the physical printer.

## Queue To Calendar Scheduling Flow

```mermaid
flowchart TD
  Select["User checks queued jobs"] --> CommitButton["Commit selected queued jobs"]
  CommitButton --> Inputs["Target week, printer, preferred start, priority"]
  Inputs --> ReadState["Read printers, existing blocks, servicer availability, changeover rules"]
  ReadState --> ForEach["Sort selected jobs by priority"]
  ForEach --> Printer{"Compatible printer exists and enabled?"}
  Printer -- No --> WarnPrinter["Warning: no compatible printer / disabled"]
  Printer -- Yes --> Changeover{"Previous print on same printer?"}
  Changeover -- Yes --> Servicer["Find next servicer window"]
  Servicer --> ServiceAvailable{"Servicer available?"}
  ServiceAvailable -- No --> WarnService["Warning: changeover blocked"]
  ServiceAvailable -- Yes --> InsertChangeover["Insert Changeover block"]
  Changeover -- No --> FindSlot["Find open printer slot"]
  InsertChangeover --> FindSlot
  FindSlot --> Fits{"Fits inside selected week?"}
  Fits -- No --> WarnFit["Warning: job does not fit"]
  Fits -- Yes --> ScheduledJob["Create scheduled_jobs record"]
  ScheduledJob --> PrintBlock["Create Print schedule_block"]
  PrintBlock --> UpdateJob["Set source job status = scheduled"]
```

Warnings are shown on the Schedule page. Jobs that cannot be placed remain queued.

## Schedule Views

```mermaid
flowchart TD
  ScheduleState["scheduledJobs + scheduleBlocks"] --> Calendar["buildScheduleCalendar(state)"]
  Calendar --> Month["Month view"]
  Calendar --> Week["Week view"]
  Calendar --> Timeline["Printer timeline view"]
  Calendar --> Summary["Schedule summaries"]

  Month --> Gantt["Gantt lanes by printer"]
  Week --> Gantt
  Timeline --> Gantt
  Gantt --> Blocks["Print, Changeover, Maintenance, Unavailable, Idle"]
  Gantt --> ServicerOverlay["Servicer availability overlays"]
```

The primary visual is the month Gantt. Week view narrows the visible date range while preserving the same lane/block model.

## Scheduling Rules

```mermaid
flowchart LR
  Rules["Scheduling rules dropdown"] --> Changeover["Changeover minutes"]
  Rules --> Servicer["Servicer availability grid"]
  Rules --> AutoComplete["Auto-complete after start"]

  Changeover --> Scheduler["commitQueuedJobsToSchedule()"]
  Servicer --> Scheduler
  AutoComplete --> Completion["completeElapsedPrintingJobs()"]
```

The servicer grid stores one availability window per weekday. Changeovers are delayed until an available servicer window exists.

## Start And Auto-Complete Flow

```mermaid
sequenceDiagram
  participant User
  participant UI as Schedule row
  participant Scheduler as scheduler.js
  participant State as AppState

  User->>UI: Clicks Start
  UI->>Scheduler: updateScheduledJobStatus(id, "printing")
  Scheduler->>State: Set job status printing
  Scheduler->>State: Set actual_start_at
  Scheduler->>State: Set expected_finish_at = now + duration
  UI->>UI: schedulePrintCompletionTimer()
  UI->>Scheduler: completeElapsedPrintingJobs()
  Scheduler->>State: If elapsed and auto-complete enabled, mark source job completed
  Scheduler->>State: Remove scheduled job and related schedule blocks
```

If `Auto-complete after start` is disabled, printing jobs remain active and are not removed automatically.

## UI Structure

```mermaid
flowchart TD
  App["renderApp()"] --> Header["Topbar: Export / Import / Clear"]
  App --> Metrics["Dashboard metric cards"]
  App --> ScheduleSummary["Dashboard schedule summary"]
  App --> Tabs["Tabs"]

  Tabs --> Jobs["Jobs"]
  Tabs --> Inventory["Inventory"]
  Tabs --> Schedule["Schedule"]
  Tabs --> Materials["Materials"]

  Jobs --> Queues["Printer queues + schedule checkboxes"]
  Inventory --> Barcode["Barcode intake"]
  Inventory --> InventoryGroups["Ready/reserve spool groups"]
  Schedule --> ScheduleMenu["Schedule dropdown controls"]
  Schedule --> Rules["Scheduling rules dropdown"]
  Schedule --> Gantt["Month/week Gantt"]
  Schedule --> ScheduledRows["Scheduled job rows"]
  Materials --> Purchase["Purchase forecast"]
  Materials --> MaterialTable["Material demand/cost table"]
```

## Local-First Boundaries

```mermaid
flowchart LR
  App["Static browser app"] --> LocalStorage["Browser localStorage"]
  App -. Not included .-> Cloud["Cloud sync"]
  App -. Not included .-> Accounts["User accounts"]
  App -. Not included .-> Billing["Billing"]
  App -. Not included .-> OctoPrint["OctoPrint / remote printer control"]
  App -. Not included .-> Backend["Backend database/API"]
```

Current boundaries:

- No backend server.
- No authentication.
- No cloud sync.
- No billing.
- No remote printer control.
- No OctoPrint integration.
- Uploaded files stay in the browser.
- Schedule state is planning state, not printer execution state.

## Current Production Lifecycle

```mermaid
flowchart LR
  Staged["Staged job / file ready"] --> Queued["Queued job"]
  Queued --> Scheduled["Scheduled calendar item"]
  Scheduled --> Printing["Printing job"]
  Printing --> Completed["Completed job"]

  Queued -. Commit .-> Scheduled
  Scheduled -. Manual Start .-> Printing
  Printing -. Estimated duration elapsed .-> Completed
```

The application is designed around the distinction between planned work and active physical printer work. `Scheduled` means a job is on the calendar. `Printing` means the user manually started it.
