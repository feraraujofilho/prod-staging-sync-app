-- CreateTable
CREATE TABLE "SyncSchedule" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "syncTypes" TEXT NOT NULL,
    "frequency" TEXT NOT NULL DEFAULT 'daily',
    "hour" INTEGER NOT NULL DEFAULT 2,
    "minute" INTEGER NOT NULL DEFAULT 0,
    "dayOfWeek" INTEGER,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastRunAt" DATETIME,
    "nextRunAt" DATETIME,
    "lastRunStatus" TEXT,
    "lastRunSummary" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "SyncSchedule_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "StoreConnection" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "SyncSchedule_connectionId_key" ON "SyncSchedule"("connectionId");

-- CreateIndex
CREATE INDEX "SyncSchedule_enabled_idx" ON "SyncSchedule"("enabled");

-- CreateIndex
CREATE INDEX "SyncSchedule_shop_idx" ON "SyncSchedule"("shop");
