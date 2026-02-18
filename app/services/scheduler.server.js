import cron from "node-cron";
import prisma from "../db.server";
import { unauthenticated } from "../shopify.server";
import { syncMetafieldDefinitions } from "./sync.metafields.server";
import { syncMetaobjectDefinitions } from "./sync.metaobjects.server";
import { syncProducts } from "./sync.products.server";
import { syncCollections } from "./sync.collections.server";
import { syncLocations } from "./sync.locations.server";
import { syncNavigationMenus } from "./sync.navigation.server";
import { syncPages } from "./sync.pages.server";
import { syncImageFiles } from "./sync.files.server";
import { syncMarkets } from "./sync.markets.server";
import { syncSearchDiscoveryMetafields } from "./sync.search-discovery.server";

// Singleton guard: prevent duplicate cron registrations in dev mode
// (remix-serve purges module cache on each request in dev)
const SCHEDULER_KEY = "__sync_scheduler__";

/**
 * Convert a SyncSchedule record into a cron expression.
 * Supports: daily, every_12h, every_6h, weekly
 */
function buildCronExpression(schedule) {
  const { frequency, minute, hour, dayOfWeek } = schedule;
  switch (frequency) {
    case "every_6h":
      return `${minute} */6 * * *`;
    case "every_12h":
      return `${minute} */12 * * *`;
    case "weekly":
      return `${minute} ${hour} * * ${dayOfWeek ?? 0}`;
    case "daily":
    default:
      return `${minute} ${hour} * * *`;
  }
}

/**
 * Calculate the next run time based on a schedule's frequency and time settings.
 */
function calculateNextRunAt(schedule) {
  const now = new Date();
  const { frequency, hour, minute, dayOfWeek } = schedule;

  const next = new Date(now);
  next.setUTCSeconds(0, 0);

  switch (frequency) {
    case "every_6h": {
      next.setUTCMinutes(minute);
      // Find next 6-hour window
      const currentHour = now.getUTCHours();
      const nextSlot = Math.ceil((currentHour + 1) / 6) * 6;
      if (nextSlot >= 24) {
        next.setUTCDate(next.getUTCDate() + 1);
        next.setUTCHours(0);
      } else {
        next.setUTCHours(nextSlot);
      }
      break;
    }
    case "every_12h": {
      next.setUTCMinutes(minute);
      const currentHour12 = now.getUTCHours();
      const nextSlot12 = Math.ceil((currentHour12 + 1) / 12) * 12;
      if (nextSlot12 >= 24) {
        next.setUTCDate(next.getUTCDate() + 1);
        next.setUTCHours(0);
      } else {
        next.setUTCHours(nextSlot12);
      }
      break;
    }
    case "weekly": {
      next.setUTCHours(hour);
      next.setUTCMinutes(minute);
      const targetDay = dayOfWeek ?? 0;
      const currentDay = now.getUTCDay();
      let daysUntil = targetDay - currentDay;
      if (daysUntil <= 0) daysUntil += 7;
      if (daysUntil === 0 && now >= next) daysUntil = 7;
      next.setUTCDate(next.getUTCDate() + daysUntil);
      break;
    }
    case "daily":
    default: {
      next.setUTCHours(hour);
      next.setUTCMinutes(minute);
      if (next <= now) {
        next.setUTCDate(next.getUTCDate() + 1);
      }
      break;
    }
  }

  return next;
}

/**
 * Run a single sync type for a given connection.
 * Returns the sync result and log ID.
 */
async function runSingleSync(shop, admin, connection, decryptedToken, syncType) {
  const syncLog = await prisma.syncLog.create({
    data: {
      shop,
      connectionId: connection.id,
      syncType,
      status: "in_progress",
      startedAt: new Date(),
    },
  });

  try {
    const onProgress = async (progress) => {
      try {
        await prisma.syncLog.update({
          where: { id: syncLog.id },
          data: {
            summary: JSON.stringify({
              progress: {
                percentage: progress.percentage ?? 0,
                stage: progress.stage ?? "running",
                message: progress.message ?? "",
              },
            }),
          },
        });
      } catch (e) {
        console.error("[Scheduler] Failed to update progress:", e);
      }
    };

    let result;

    switch (syncType) {
      case "metafield_definitions": {
        const metafieldTypes = [
          "COLLECTION", "CUSTOMER", "ORDER", "DRAFTORDER", "PAGE",
          "SHOP", "ARTICLE", "BLOG", "COMPANY", "COMPANYLOCATION",
          "LOCATION", "MARKET",
        ];
        result = await syncMetafieldDefinitions(
          connection.storeDomain, decryptedToken, admin, metafieldTypes,
        );
        break;
      }
      case "metaobject_definitions":
        result = await syncMetaobjectDefinitions(
          connection.storeDomain, decryptedToken, admin, connection.id,
        );
        break;
      case "products":
        result = await syncProducts(
          connection.storeDomain, decryptedToken, admin, connection.id, onProgress,
        );
        break;
      case "collections":
        result = await syncCollections(
          connection.storeDomain, decryptedToken, admin, connection.id, onProgress,
        );
        break;
      case "locations":
        result = await syncLocations(
          connection.storeDomain, decryptedToken, admin, connection.id, onProgress,
        );
        break;
      case "navigation":
        result = await syncNavigationMenus(
          connection.storeDomain, decryptedToken, admin, connection.id,
        );
        break;
      case "pages":
        result = await syncPages(
          connection.storeDomain, decryptedToken, admin, connection.id,
        );
        break;
      case "files":
        result = await syncImageFiles(
          connection.storeDomain, decryptedToken, admin, connection.id, onProgress,
        );
        break;
      case "markets":
        result = await syncMarkets(
          connection.storeDomain, decryptedToken, admin, connection.id,
        );
        break;
      case "search_discovery":
        result = await syncSearchDiscoveryMetafields(
          connection.storeDomain, decryptedToken, admin, connection.id, onProgress,
        );
        break;
      default:
        throw new Error(`Unknown sync type: ${syncType}`);
    }

    const hasErrors = result.summary?.errors?.length > 0;
    const hasSuccess = result.summary?.created > 0 || result.summary?.updated > 0;

    let status = "failed";
    if (hasSuccess && hasErrors) {
      status = "partially_successful";
    } else if (hasSuccess || (!hasErrors && (result.summary?.total > 0 || result.summary?.skipped > 0))) {
      status = "success";
    }

    await prisma.syncLog.update({
      where: { id: syncLog.id },
      data: {
        status,
        summary: JSON.stringify(result.summary || {}),
        logs: JSON.stringify(result.logs || result.log || []),
        completedAt: new Date(),
      },
    });

    return { syncType, status, summary: result.summary };
  } catch (err) {
    console.error(`[Scheduler] Sync ${syncType} failed:`, err.message);
    await prisma.syncLog.update({
      where: { id: syncLog.id },
      data: {
        status: "failed",
        summary: JSON.stringify({ error: err.message }),
        completedAt: new Date(),
      },
    });
    return { syncType, status: "failed", error: err.message };
  }
}

/**
 * Execute a full scheduled sync: runs all configured sync types sequentially.
 */
async function executeScheduledSync(schedule) {
  const startTime = new Date();
  console.log(`[Scheduler] Starting scheduled sync for shop=${schedule.shop}, connection=${schedule.connectionId}`);

  try {
    // Get connection details
    const connection = await prisma.storeConnection.findUnique({
      where: { id: schedule.connectionId },
    });

    if (!connection || !connection.isActive) {
      console.log("[Scheduler] Connection not found or inactive, skipping");
      await prisma.syncSchedule.update({
        where: { id: schedule.id },
        data: {
          lastRunAt: startTime,
          lastRunStatus: "failed",
          lastRunSummary: JSON.stringify({ error: "Connection not found or inactive" }),
          nextRunAt: calculateNextRunAt(schedule),
        },
      });
      return;
    }

    // Decrypt the production store token
    const { decrypt } = await import("../utils/encryption.server.js");
    const decryptedToken = decrypt(connection.encryptedToken);
    if (!decryptedToken) {
      console.error("[Scheduler] Failed to decrypt token");
      await prisma.syncSchedule.update({
        where: { id: schedule.id },
        data: {
          lastRunAt: startTime,
          lastRunStatus: "failed",
          lastRunSummary: JSON.stringify({ error: "Failed to decrypt access token" }),
          nextRunAt: calculateNextRunAt(schedule),
        },
      });
      return;
    }

    // Get the staging store admin client using offline token
    const { admin } = await unauthenticated.admin(schedule.shop);

    // Parse sync types
    const syncTypes = JSON.parse(schedule.syncTypes);
    const results = [];

    // Run each sync type sequentially
    for (const syncType of syncTypes) {
      console.log(`[Scheduler] Running ${syncType}...`);
      const result = await runSingleSync(
        schedule.shop, admin, connection, decryptedToken, syncType,
      );
      results.push(result);
      console.log(`[Scheduler] ${syncType}: ${result.status}`);
    }

    // Summarize all results
    const allSucceeded = results.every((r) => r.status === "success");
    const allFailed = results.every((r) => r.status === "failed");
    const overallStatus = allSucceeded ? "success" : allFailed ? "failed" : "partial";

    const elapsed = ((Date.now() - startTime.getTime()) / 1000).toFixed(1);
    console.log(`[Scheduler] Completed in ${elapsed}s — status: ${overallStatus}`);

    await prisma.syncSchedule.update({
      where: { id: schedule.id },
      data: {
        lastRunAt: startTime,
        lastRunStatus: overallStatus,
        lastRunSummary: JSON.stringify({
          duration: `${elapsed}s`,
          results: results.map((r) => ({
            syncType: r.syncType,
            status: r.status,
            created: r.summary?.created,
            updated: r.summary?.updated,
            failed: r.summary?.failed,
          })),
        }),
        nextRunAt: calculateNextRunAt(schedule),
      },
    });
  } catch (err) {
    console.error("[Scheduler] Unexpected error:", err);
    await prisma.syncSchedule.update({
      where: { id: schedule.id },
      data: {
        lastRunAt: startTime,
        lastRunStatus: "failed",
        lastRunSummary: JSON.stringify({ error: err.message }),
        nextRunAt: calculateNextRunAt(schedule),
      },
    });
  }
}

/**
 * Initialize the scheduler. Loads all enabled schedules from DB and
 * registers cron jobs for each. Uses globalThis to prevent duplicates.
 */
export async function initScheduler() {
  // Singleton guard
  if (globalThis[SCHEDULER_KEY]) {
    return globalThis[SCHEDULER_KEY];
  }

  console.log("[Scheduler] Initializing...");

  const scheduler = {
    tasks: new Map(), // connectionId -> cron task
  };

  globalThis[SCHEDULER_KEY] = scheduler;

  try {
    const schedules = await prisma.syncSchedule.findMany({
      where: { enabled: true },
    });

    for (const schedule of schedules) {
      registerCronTask(scheduler, schedule);
    }

    console.log(`[Scheduler] Registered ${schedules.length} schedule(s)`);
  } catch (err) {
    console.error("[Scheduler] Failed to load schedules:", err.message);
  }

  return scheduler;
}

/**
 * Register a cron task for a given schedule.
 */
function registerCronTask(scheduler, schedule) {
  const cronExpr = buildCronExpression(schedule);

  // Stop existing task for this connection if any
  if (scheduler.tasks.has(schedule.connectionId)) {
    scheduler.tasks.get(schedule.connectionId).stop();
  }

  const task = cron.schedule(cronExpr, () => {
    executeScheduledSync(schedule).catch((err) => {
      console.error("[Scheduler] Cron execution error:", err);
    });
  }, {
    timezone: "UTC",
  });

  scheduler.tasks.set(schedule.connectionId, task);
  console.log(`[Scheduler] Registered cron "${cronExpr}" for connection ${schedule.connectionId}`);
}

/**
 * Reload a single schedule (after create/update/delete from UI).
 * Call this from the schedule route action.
 */
export async function reloadSchedule(connectionId) {
  const scheduler = globalThis[SCHEDULER_KEY];
  if (!scheduler) return;

  // Stop existing task
  if (scheduler.tasks.has(connectionId)) {
    scheduler.tasks.get(connectionId).stop();
    scheduler.tasks.delete(connectionId);
  }

  // Reload from DB
  const schedule = await prisma.syncSchedule.findUnique({
    where: { connectionId },
  });

  if (schedule && schedule.enabled) {
    registerCronTask(scheduler, schedule);
  }
}

/**
 * Remove a schedule's cron task.
 */
export async function removeSchedule(connectionId) {
  const scheduler = globalThis[SCHEDULER_KEY];
  if (!scheduler) return;

  if (scheduler.tasks.has(connectionId)) {
    scheduler.tasks.get(connectionId).stop();
    scheduler.tasks.delete(connectionId);
    console.log(`[Scheduler] Removed schedule for connection ${connectionId}`);
  }
}

/**
 * Run a schedule immediately (for "Run Now" button).
 */
export async function runScheduleNow(connectionId) {
  const schedule = await prisma.syncSchedule.findUnique({
    where: { connectionId },
  });

  if (!schedule) {
    throw new Error("Schedule not found");
  }

  // Run in background
  executeScheduledSync(schedule).catch((err) => {
    console.error("[Scheduler] Manual run error:", err);
  });

  return { started: true };
}

export { calculateNextRunAt, buildCronExpression };
