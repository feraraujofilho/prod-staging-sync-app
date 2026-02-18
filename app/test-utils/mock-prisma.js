/**
 * Mock Prisma client for testing resource-mapping operations
 * In-memory store that mimics Prisma's API
 */

export function createMockPrisma() {
  const store = {
    resourceMapping: [],
    unmappedReference: [],
  };

  return {
    resourceMapping: {
      upsert: async ({ where, update, create }) => {
        const key = where.storeConnectionId_resourceType_productionId;
        const existing = store.resourceMapping.find(
          (r) =>
            r.storeConnectionId === key.storeConnectionId &&
            r.resourceType === key.resourceType &&
            r.productionId === key.productionId,
        );

        if (existing) {
          Object.assign(existing, update);
          return existing;
        }

        const record = { id: `mock-${Date.now()}`, ...create };
        store.resourceMapping.push(record);
        return record;
      },

      findUnique: async ({ where }) => {
        const key = where.storeConnectionId_resourceType_productionId;
        return (
          store.resourceMapping.find(
            (r) =>
              r.storeConnectionId === key.storeConnectionId &&
              r.resourceType === key.resourceType &&
              r.productionId === key.productionId,
          ) || null
        );
      },

      findMany: async ({ where, take, skip, orderBy } = {}) => {
        let results = store.resourceMapping.filter((r) => {
          if (where?.storeConnectionId && r.storeConnectionId !== where.storeConnectionId) return false;
          if (where?.resourceType && r.resourceType !== where.resourceType) return false;
          return true;
        });
        if (skip) results = results.slice(skip);
        if (take) results = results.slice(0, take);
        return results;
      },

      count: async ({ where } = {}) => {
        return store.resourceMapping.filter((r) => {
          if (where?.storeConnectionId && r.storeConnectionId !== where.storeConnectionId) return false;
          if (where?.resourceType && r.resourceType !== where.resourceType) return false;
          return true;
        }).length;
      },

      deleteMany: async ({ where }) => {
        const before = store.resourceMapping.length;
        store.resourceMapping = store.resourceMapping.filter(
          (r) => r.storeConnectionId !== where.storeConnectionId,
        );
        return { count: before - store.resourceMapping.length };
      },

      groupBy: async ({ by, where, _count }) => {
        const groups = {};
        store.resourceMapping
          .filter((r) => !where?.storeConnectionId || r.storeConnectionId === where.storeConnectionId)
          .forEach((r) => {
            const key = r[by[0]];
            groups[key] = (groups[key] || 0) + 1;
          });
        return Object.entries(groups).map(([type, count]) => ({
          [by[0]]: type,
          _count: count,
        }));
      },
    },

    unmappedReference: {
      upsert: async ({ where, update, create }) => {
        const key = where.storeConnectionId_productionGid_context;
        const existing = store.unmappedReference.find(
          (r) =>
            r.storeConnectionId === key.storeConnectionId &&
            r.productionGid === key.productionGid &&
            r.context === key.context,
        );

        if (existing) {
          Object.assign(existing, update);
          return existing;
        }

        const record = { id: `mock-${Date.now()}`, ...create };
        store.unmappedReference.push(record);
        return record;
      },

      findMany: async ({ where, take, skip } = {}) => {
        let results = store.unmappedReference.filter((r) => {
          if (where?.storeConnectionId && r.storeConnectionId !== where.storeConnectionId) return false;
          if (where?.resourceType && r.resourceType !== where.resourceType) return false;
          if (where?.resolved !== undefined && r.resolved !== where.resolved) return false;
          return true;
        });
        if (skip) results = results.slice(skip);
        if (take) results = results.slice(0, take);
        return results;
      },

      count: async ({ where } = {}) => {
        return store.unmappedReference.filter((r) => {
          if (where?.storeConnectionId && r.storeConnectionId !== where.storeConnectionId) return false;
          if (where?.resolved !== undefined && r.resolved !== where.resolved) return false;
          return true;
        }).length;
      },

      update: async ({ where, data }) => {
        const record = store.unmappedReference.find((r) => r.id === where.id);
        if (record) Object.assign(record, data);
        return record;
      },
    },

    // Direct access for test setup/assertions
    _store: store,
    _reset: () => {
      store.resourceMapping.length = 0;
      store.unmappedReference.length = 0;
    },
  };
}
