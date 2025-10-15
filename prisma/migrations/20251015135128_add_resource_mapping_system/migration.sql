-- CreateTable
CREATE TABLE "ResourceMapping" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "resourceType" TEXT NOT NULL,
    "productionId" TEXT NOT NULL,
    "stagingId" TEXT NOT NULL,
    "productionGid" TEXT NOT NULL,
    "stagingGid" TEXT NOT NULL,
    "matchKey" TEXT NOT NULL,
    "matchValue" TEXT NOT NULL,
    "syncId" TEXT,
    "title" TEXT,
    "storeConnectionId" TEXT NOT NULL,
    "lastSyncedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "metadata" TEXT,
    CONSTRAINT "ResourceMapping_storeConnectionId_fkey" FOREIGN KEY ("storeConnectionId") REFERENCES "StoreConnection" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "UnmappedReference" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "storeConnectionId" TEXT NOT NULL,
    "resourceType" TEXT NOT NULL,
    "productionGid" TEXT NOT NULL,
    "productionId" TEXT NOT NULL,
    "context" TEXT NOT NULL,
    "foundInSyncType" TEXT NOT NULL,
    "attemptedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved" BOOLEAN NOT NULL DEFAULT false,
    "resolvedAt" DATETIME,
    CONSTRAINT "UnmappedReference_storeConnectionId_fkey" FOREIGN KEY ("storeConnectionId") REFERENCES "StoreConnection" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "ResourceMapping_storeConnectionId_resourceType_idx" ON "ResourceMapping"("storeConnectionId", "resourceType");

-- CreateIndex
CREATE INDEX "ResourceMapping_storeConnectionId_matchKey_matchValue_idx" ON "ResourceMapping"("storeConnectionId", "matchKey", "matchValue");

-- CreateIndex
CREATE INDEX "ResourceMapping_syncId_idx" ON "ResourceMapping"("syncId");

-- CreateIndex
CREATE UNIQUE INDEX "ResourceMapping_storeConnectionId_resourceType_productionId_key" ON "ResourceMapping"("storeConnectionId", "resourceType", "productionId");

-- CreateIndex
CREATE INDEX "UnmappedReference_storeConnectionId_resolved_idx" ON "UnmappedReference"("storeConnectionId", "resolved");

-- CreateIndex
CREATE INDEX "UnmappedReference_resourceType_resolved_idx" ON "UnmappedReference"("resourceType", "resolved");

-- CreateIndex
CREATE UNIQUE INDEX "UnmappedReference_storeConnectionId_productionGid_context_key" ON "UnmappedReference"("storeConnectionId", "productionGid", "context");
