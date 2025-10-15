/**
 * GID Translation Utility
 * Translates Shopify GIDs in metafield values from production to staging
 * Handles various metafield types and nested structures
 */

import {
  getMappingByProductionGid,
  logUnmappedReference,
  extractResourceTypeFromGid,
} from "../services/resource-mapping.server.js";

// Regex pattern to match Shopify GIDs
const GID_PATTERN = /gid:\/\/shopify\/([A-Za-z]+)\/(\d+)/g;

/**
 * Check if a string contains GID references
 * @param {string} value - String to check
 * @returns {boolean} True if contains GIDs
 */
export function containsGids(value) {
  if (typeof value !== "string") return false;
  return GID_PATTERN.test(value);
}

/**
 * Extract all GIDs from a string
 * @param {string} value - String to extract GIDs from
 * @returns {Array<string>} Array of GID strings
 */
export function extractGids(value) {
  if (typeof value !== "string") return [];
  const gids = [];
  const regex = new RegExp(GID_PATTERN);
  let match;
  while ((match = regex.exec(value)) !== null) {
    gids.push(match[0]);
  }
  return gids;
}

/**
 * Translate a single GID from production to staging
 * @param {string} storeConnectionId - Store connection ID
 * @param {string} productionGid - Production GID to translate
 * @param {string} context - Context for logging (e.g., "product:123 metafield:custom.related")
 * @param {string} syncType - Current sync type
 * @returns {Promise<Object>} Result object with stagingGid or null
 */
export async function translateGid(
  storeConnectionId,
  productionGid,
  context = "",
  syncType = "unknown",
) {
  const mapping = await getMappingByProductionGid(
    storeConnectionId,
    productionGid,
  );

  if (mapping) {
    return {
      success: true,
      stagingGid: mapping.stagingGid,
      resourceType: mapping.resourceType,
    };
  }

  // Log unmapped reference
  await logUnmappedReference(
    storeConnectionId,
    productionGid,
    context,
    syncType,
  );

  return {
    success: false,
    stagingGid: null,
    resourceType: extractResourceTypeFromGid(productionGid),
    unmapped: true,
  };
}

/**
 * Translate all GIDs in a string value
 * @param {string} storeConnectionId - Store connection ID
 * @param {string} value - String containing GIDs
 * @param {string} context - Context for logging
 * @param {string} syncType - Current sync type
 * @returns {Promise<Object>} Result object with translated value and stats
 */
export async function translateGidsInString(
  storeConnectionId,
  value,
  context = "",
  syncType = "unknown",
) {
  if (!containsGids(value)) {
    return {
      value,
      translated: 0,
      unmapped: 0,
      skipped: false,
    };
  }

  const gids = extractGids(value);
  let translatedValue = value;
  let translatedCount = 0;
  let unmappedCount = 0;

  for (const productionGid of gids) {
    const result = await translateGid(
      storeConnectionId,
      productionGid,
      context,
      syncType,
    );

    if (result.success && result.stagingGid) {
      translatedValue = translatedValue.replace(
        productionGid,
        result.stagingGid,
      );
      translatedCount++;
    } else {
      unmappedCount++;
    }
  }

  // If we have unmapped references, we might want to skip this value entirely
  // to avoid broken references in staging
  const skipValue = unmappedCount > 0;

  return {
    value: skipValue ? null : translatedValue,
    originalValue: value,
    translated: translatedCount,
    unmapped: unmappedCount,
    skipped: skipValue,
  };
}

/**
 * Translate GIDs in an array of strings
 * @param {string} storeConnectionId - Store connection ID
 * @param {Array<string>} array - Array of strings
 * @param {string} context - Context for logging
 * @param {string} syncType - Current sync type
 * @returns {Promise<Object>} Result object with translated array and stats
 */
export async function translateGidsInArray(
  storeConnectionId,
  array,
  context = "",
  syncType = "unknown",
) {
  if (!Array.isArray(array)) {
    return {
      value: array,
      translated: 0,
      unmapped: 0,
      skipped: false,
    };
  }

  const translatedArray = [];
  let totalTranslated = 0;
  let totalUnmapped = 0;

  for (const item of array) {
    if (typeof item === "string" && containsGids(item)) {
      const result = await translateGidsInString(
        storeConnectionId,
        item,
        context,
        syncType,
      );

      if (!result.skipped && result.value) {
        translatedArray.push(result.value);
        totalTranslated += result.translated;
        totalUnmapped += result.unmapped;
      } else {
        // Skip items with unmapped references
        totalUnmapped += result.unmapped;
      }
    } else {
      translatedArray.push(item);
    }
  }

  return {
    value: translatedArray,
    translated: totalTranslated,
    unmapped: totalUnmapped,
    skipped: false,
  };
}

/**
 * Translate GIDs in a JSON object (recursive)
 * @param {string} storeConnectionId - Store connection ID
 * @param {Object} obj - JSON object to translate
 * @param {string} context - Context for logging
 * @param {string} syncType - Current sync type
 * @returns {Promise<Object>} Result object with translated object and stats
 */
export async function translateGidsInObject(
  storeConnectionId,
  obj,
  context = "",
  syncType = "unknown",
) {
  if (typeof obj !== "object" || obj === null) {
    if (typeof obj === "string" && containsGids(obj)) {
      return await translateGidsInString(
        storeConnectionId,
        obj,
        context,
        syncType,
      );
    }
    return {
      value: obj,
      translated: 0,
      unmapped: 0,
      skipped: false,
    };
  }

  if (Array.isArray(obj)) {
    return await translateGidsInArray(storeConnectionId, obj, context, syncType);
  }

  const translatedObj = {};
  let totalTranslated = 0;
  let totalUnmapped = 0;

  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === "string" && containsGids(value)) {
      const result = await translateGidsInString(
        storeConnectionId,
        value,
        `${context}.${key}`,
        syncType,
      );

      if (!result.skipped && result.value) {
        translatedObj[key] = result.value;
        totalTranslated += result.translated;
        totalUnmapped += result.unmapped;
      } else {
        totalUnmapped += result.unmapped;
      }
    } else if (typeof value === "object" && value !== null) {
      const result = await translateGidsInObject(
        storeConnectionId,
        value,
        `${context}.${key}`,
        syncType,
      );

      translatedObj[key] = result.value;
      totalTranslated += result.translated;
      totalUnmapped += result.unmapped;
    } else {
      translatedObj[key] = value;
    }
  }

  return {
    value: translatedObj,
    translated: totalTranslated,
    unmapped: totalUnmapped,
    skipped: false,
  };
}

/**
 * Translate GIDs in a metafield value based on its type
 * @param {string} storeConnectionId - Store connection ID
 * @param {Object} metafield - Metafield object with namespace, key, value, and type
 * @param {string} ownerContext - Owner context (e.g., "product:123")
 * @param {string} syncType - Current sync type
 * @returns {Promise<Object>} Result object with translated metafield
 */
export async function translateMetafieldValue(
  storeConnectionId,
  metafield,
  ownerContext = "",
  syncType = "unknown",
) {
  const { namespace, key, value, type } = metafield;
  const context = `${ownerContext} metafield:${namespace}.${key}`;

  // Handle different metafield types
  switch (type) {
    case "single_line_text_field":
    case "multi_line_text_field":
    case "url": {
      if (typeof value === "string" && containsGids(value)) {
        const result = await translateGidsInString(
          storeConnectionId,
          value,
          context,
          syncType,
        );
        return {
          ...metafield,
          value: result.value,
          translationStats: {
            translated: result.translated,
            unmapped: result.unmapped,
            skipped: result.skipped,
          },
        };
      }
      return { ...metafield, translationStats: { translated: 0, unmapped: 0, skipped: false } };
    }

    case "list.single_line_text_field": {
      try {
        const arrayValue = typeof value === "string" ? JSON.parse(value) : value;
        const result = await translateGidsInArray(
          storeConnectionId,
          arrayValue,
          context,
          syncType,
        );
        return {
          ...metafield,
          value: JSON.stringify(result.value),
          translationStats: {
            translated: result.translated,
            unmapped: result.unmapped,
            skipped: result.skipped,
          },
        };
      } catch (error) {
        console.error(`Error parsing list metafield ${namespace}.${key}:`, error);
        return { ...metafield, translationStats: { translated: 0, unmapped: 0, skipped: false } };
      }
    }

    case "json": {
      try {
        const jsonValue = typeof value === "string" ? JSON.parse(value) : value;
        const result = await translateGidsInObject(
          storeConnectionId,
          jsonValue,
          context,
          syncType,
        );
        return {
          ...metafield,
          value: JSON.stringify(result.value),
          translationStats: {
            translated: result.translated,
            unmapped: result.unmapped,
            skipped: result.skipped,
          },
        };
      } catch (error) {
        console.error(`Error parsing JSON metafield ${namespace}.${key}:`, error);
        return { ...metafield, translationStats: { translated: 0, unmapped: 0, skipped: false } };
      }
    }

    default:
      // For other types, return as-is
      return { ...metafield, translationStats: { translated: 0, unmapped: 0, skipped: false } };
  }
}

/**
 * Translate GIDs in multiple metafields
 * @param {string} storeConnectionId - Store connection ID
 * @param {Array<Object>} metafields - Array of metafield objects
 * @param {string} ownerContext - Owner context (e.g., "product:123")
 * @param {string} syncType - Current sync type
 * @returns {Promise<Object>} Result with translated metafields and stats
 */
export async function translateMetafields(
  storeConnectionId,
  metafields,
  ownerContext = "",
  syncType = "unknown",
) {
  if (!Array.isArray(metafields) || metafields.length === 0) {
    return {
      metafields: [],
      stats: {
        total: 0,
        translated: 0,
        unmapped: 0,
        skipped: 0,
      },
    };
  }

  const translatedMetafields = [];
  const stats = {
    total: metafields.length,
    translated: 0,
    unmapped: 0,
    skipped: 0,
  };

  for (const metafield of metafields) {
    const result = await translateMetafieldValue(
      storeConnectionId,
      metafield,
      ownerContext,
      syncType,
    );

    // Only include metafields that weren't skipped
    if (!result.translationStats.skipped) {
      translatedMetafields.push(result);
      stats.translated += result.translationStats.translated;
      stats.unmapped += result.translationStats.unmapped;
    } else {
      stats.skipped++;
      stats.unmapped += result.translationStats.unmapped;
      console.warn(
        `⚠️ Skipped metafield ${metafield.namespace}.${metafield.key} for ${ownerContext} due to unmapped references`,
      );
    }
  }

  return {
    metafields: translatedMetafields,
    stats,
  };
}

