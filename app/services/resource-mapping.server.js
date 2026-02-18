/**
 * Resource Mapping Service
 * Manages mappings between production and staging resource IDs
 * Handles GID translation for metafield values containing resource references
 */

import prisma from "../db.server";

/**
 * Extract numeric ID from Shopify GID
 * @param {string} gid - Shopify GID (e.g., "gid://shopify/Product/123456")
 * @returns {string} Numeric ID
 */
export function extractIdFromGid(gid) {
  if (!gid) return null;
  const match = gid.match(/\/(\d+)$/);
  return match ? match[1] : null;
}

/**
 * Extract resource type from Shopify GID
 * @param {string} gid - Shopify GID (e.g., "gid://shopify/Product/123456")
 * @returns {string} Resource type (e.g., "Product")
 */
export function extractResourceTypeFromGid(gid) {
  if (!gid) return null;
  const match = gid.match(/gid:\/\/shopify\/([^\/]+)\/\d+/);
  return match ? match[1] : null;
}

/**
 * Convert resource type from GID format to database format
 * @param {string} gidType - Resource type from GID (e.g., "Product", "ProductVariant")
 * @returns {string} Database resource type (e.g., "product", "variant")
 */
export function normalizeResourceType(gidType) {
  const typeMap = {
    Product: "product",
    ProductVariant: "variant",
    Collection: "collection",
    Market: "market",
    Location: "location",
    Page: "page",
    MediaImage: "file",
    GenericFile: "file",
    Video: "file",
    Metaobject: "metaobject",
    MetaobjectDefinition: "metaobject_definition",
    Menu: "navigation",
    InventoryItem: "inventory_item",
    InventoryLevel: "inventory_level",
  };
  return typeMap[gidType] || gidType?.toLowerCase();
}

/**
 * Save a single resource mapping
 * @param {string} storeConnectionId - Store connection ID
 * @param {string} resourceType - Type of resource
 * @param {Object} mapping - Mapping data
 * @returns {Promise<Object>} Created mapping
 *
 * Expected mapping object structure:
 * {
 *   productionId: string,
 *   stagingId: string,
 *   productionGid: string,
 *   stagingGid: string,
 *   matchKey: string (e.g., 'handle', 'name', 'filename', 'type'),
 *   matchValue: string (e.g., 'my-product', 'Main Location', 'logo.png'),
 *   syncId?: string (optional, from custom.custom_id metafield),
 *   title?: string (optional, for display),
 *   metadata?: object (optional, additional data like selectedOptions for variants)
 * }
 */
export async function saveMapping(storeConnectionId, resourceType, mapping) {
  const {
    productionId,
    stagingId,
    productionGid,
    stagingGid,
    matchKey,
    matchValue,
    syncId,
    title,
    metadata,
  } = mapping;

  if (!matchKey || !matchValue) {
    throw new Error(
      `matchKey and matchValue are required for resource mapping. Got: ${JSON.stringify({ matchKey, matchValue })}`,
    );
  }

  return await prisma.resourceMapping.upsert({
    where: {
      storeConnectionId_resourceType_productionId: {
        storeConnectionId,
        resourceType,
        productionId,
      },
    },
    update: {
      stagingId,
      stagingGid,
      matchKey,
      matchValue,
      syncId,
      title,
      metadata: metadata ? JSON.stringify(metadata) : null,
      lastSyncedAt: new Date(),
    },
    create: {
      storeConnectionId,
      resourceType,
      productionId,
      stagingId,
      productionGid,
      stagingGid,
      matchKey,
      matchValue,
      syncId,
      title,
      metadata: metadata ? JSON.stringify(metadata) : null,
    },
  });
}

/**
 * Save multiple resource mappings in batch
 * @param {string} storeConnectionId - Store connection ID
 * @param {string} resourceType - Type of resource
 * @param {Array<Object>} mappings - Array of mapping objects
 * @returns {Promise<Object>} Summary of created/updated mappings
 */
export async function saveMappings(storeConnectionId, resourceType, mappings) {
  const results = { created: 0, updated: 0, failed: 0, errors: [] };

  // Process in chunks to avoid overwhelming the database
  const chunkSize = 50;
  for (let i = 0; i < mappings.length; i += chunkSize) {
    const chunk = mappings.slice(i, i + chunkSize);

    for (const mapping of chunk) {
      try {
        await saveMapping(storeConnectionId, resourceType, mapping);
        results.created++;
      } catch (error) {
        results.failed++;
        results.errors.push(
          `Failed to save mapping for ${resourceType} ${mapping.productionId}: ${error.message}`,
        );
        console.error(
          `Error saving mapping for ${resourceType}:`,
          error.message,
        );
      }
    }
  }

  return results;
}

/**
 * Get a mapping by production GID
 * @param {string} storeConnectionId - Store connection ID
 * @param {string} productionGid - Production GID to look up
 * @returns {Promise<Object|null>} Mapping object or null
 */
export async function getMappingByProductionGid(
  storeConnectionId,
  productionGid,
) {
  const resourceType = extractResourceTypeFromGid(productionGid);
  const productionId = extractIdFromGid(productionGid);

  if (!resourceType || !productionId) {
    return null;
  }

  const normalizedType = normalizeResourceType(resourceType);

  return await prisma.resourceMapping.findUnique({
    where: {
      storeConnectionId_resourceType_productionId: {
        storeConnectionId,
        resourceType: normalizedType,
        productionId,
      },
    },
  });
}

/**
 * Get all mappings for a resource type
 * @param {string} storeConnectionId - Store connection ID
 * @param {string} resourceType - Type of resource
 * @param {Object} options - Query options (limit, offset, orderBy)
 * @returns {Promise<Array>} Array of mapping objects
 */
export async function getMappings(
  storeConnectionId,
  resourceType,
  options = {},
) {
  const {
    limit = 100,
    offset = 0,
    orderBy = { lastSyncedAt: "desc" },
  } = options;

  const where = {
    storeConnectionId,
  };

  if (resourceType && resourceType !== "all") {
    where.resourceType = resourceType;
  }

  return await prisma.resourceMapping.findMany({
    where,
    orderBy,
    take: limit,
    skip: offset,
  });
}

/**
 * Get count of mappings for a resource type
 * @param {string} storeConnectionId - Store connection ID
 * @param {string} resourceType - Type of resource (or "all")
 * @returns {Promise<number>} Count of mappings
 */
export async function getMappingsCount(
  storeConnectionId,
  resourceType = "all",
) {
  const where = {
    storeConnectionId,
  };

  if (resourceType && resourceType !== "all") {
    where.resourceType = resourceType;
  }

  return await prisma.resourceMapping.count({ where });
}

/**
 * Log an unmapped reference
 * @param {string} storeConnectionId - Store connection ID
 * @param {string} productionGid - Production GID that couldn't be mapped
 * @param {string} context - Context where the reference was found
 * @param {string} foundInSyncType - Which sync type found this reference
 * @returns {Promise<Object>} Created unmapped reference record
 */
export async function logUnmappedReference(
  storeConnectionId,
  productionGid,
  context,
  foundInSyncType,
) {
  const resourceType = extractResourceTypeFromGid(productionGid);
  const productionId = extractIdFromGid(productionGid);

  if (!resourceType || !productionId) {
    console.warn(
      `Invalid GID for unmapped reference: ${productionGid} in ${context}`,
    );
    return null;
  }

  try {
    return await prisma.unmappedReference.upsert({
      where: {
        storeConnectionId_productionGid_context: {
          storeConnectionId,
          productionGid,
          context,
        },
      },
      update: {
        attemptedAt: new Date(),
        foundInSyncType,
      },
      create: {
        storeConnectionId,
        resourceType,
        productionGid,
        productionId,
        context,
        foundInSyncType,
      },
    });
  } catch (error) {
    console.error("Error logging unmapped reference:", error.message);
    return null;
  }
}

/**
 * Get all unmapped references
 * @param {string} storeConnectionId - Store connection ID
 * @param {Object} options - Query options
 * @returns {Promise<Array>} Array of unmapped reference objects
 */
export async function getUnmappedReferences(storeConnectionId, options = {}) {
  const {
    resourceType = null,
    resolved = false,
    limit = 100,
    offset = 0,
  } = options;

  const where = {
    storeConnectionId,
    resolved,
  };

  if (resourceType) {
    where.resourceType = resourceType;
  }

  return await prisma.unmappedReference.findMany({
    where,
    orderBy: { attemptedAt: "desc" },
    take: limit,
    skip: offset,
  });
}

/**
 * Get count of unmapped references
 * @param {string} storeConnectionId - Store connection ID
 * @param {Object} options - Query options
 * @returns {Promise<number>} Count of unmapped references
 */
export async function getUnmappedReferencesCount(
  storeConnectionId,
  options = {},
) {
  const { resourceType = null, resolved = false } = options;

  const where = {
    storeConnectionId,
    resolved,
  };

  if (resourceType) {
    where.resourceType = resourceType;
  }

  return await prisma.unmappedReference.count({ where });
}

/**
 * Mark an unmapped reference as resolved
 * @param {string} id - Unmapped reference ID
 * @returns {Promise<Object>} Updated unmapped reference
 */
export async function markUnmappedReferenceResolved(id) {
  return await prisma.unmappedReference.update({
    where: { id },
    data: {
      resolved: true,
      resolvedAt: new Date(),
    },
  });
}

/**
 * Delete all mappings for a store connection
 * @param {string} storeConnectionId - Store connection ID
 * @returns {Promise<Object>} Delete result
 */
export async function deleteMappings(storeConnectionId) {
  return await prisma.resourceMapping.deleteMany({
    where: { storeConnectionId },
  });
}

/**
 * Get mapping statistics for a store connection
 * @param {string} storeConnectionId - Store connection ID
 * @returns {Promise<Object>} Statistics object
 */
export async function getMappingStats(storeConnectionId) {
  const mappingsByType = await prisma.resourceMapping.groupBy({
    by: ["resourceType"],
    where: { storeConnectionId },
    _count: true,
  });

  const unmappedByType = await prisma.unmappedReference.groupBy({
    by: ["resourceType"],
    where: { storeConnectionId, resolved: false },
    _count: true,
  });

  const totalMappings = await prisma.resourceMapping.count({
    where: { storeConnectionId },
  });

  const totalUnmapped = await prisma.unmappedReference.count({
    where: { storeConnectionId, resolved: false },
  });

  return {
    totalMappings,
    totalUnmapped,
    mappingsByType: mappingsByType.reduce((acc, item) => {
      acc[item.resourceType] = item._count;
      return acc;
    }, {}),
    unmappedByType: unmappedByType.reduce((acc, item) => {
      acc[item.resourceType] = item._count;
      return acc;
    }, {}),
  };
}
