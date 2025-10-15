/**
 * Location matching helper for cross-store synchronization
 * Handles location matching by name since IDs differ between stores
 */

/**
 * Get all locations from a store
 * @param {Object} admin - Shopify admin API client
 * @returns {Promise<Array>} Array of location objects
 */
export async function getLocations(admin) {
  const query = `
    query GetLocations($first: Int!) {
      locations(first: $first) {
        edges {
          node {
            id
            name
            address {
              address1
              address2
              city
              province
              country
              zip
            }
            isActive
            fulfillsOnlineOrders
            hasActiveInventory
          }
        }
      }
    }
  `;

  try {
    const response = await admin.graphql(query, {
      variables: { first: 100 },
    });
    const result = await response.json();

    if (result.errors) {
      throw new Error(
        `GraphQL errors: ${result.errors.map((e) => e.message).join(", ")}`,
      );
    }

    return result.data.locations.edges.map((edge) => edge.node);
  } catch (error) {
    console.error("Error fetching locations:", error);
    throw error;
  }
}

/**
 * Match locations between production and staging stores by name
 * @param {Array} productionLocations - Locations from production store
 * @param {Array} stagingLocations - Locations from staging store
 * @returns {Map} Map of production location ID to staging location ID
 */
export function matchLocationsByName(productionLocations, stagingLocations) {
  const locationMap = new Map();

  for (const prodLocation of productionLocations) {
    const stagingLocation = stagingLocations.find(
      (sl) =>
        sl.name.toLowerCase() === prodLocation.name.toLowerCase() &&
        sl.isActive,
    );

    if (stagingLocation) {
      locationMap.set(prodLocation.id, stagingLocation.id);
      console.log(
        `Matched location: "${prodLocation.name}" - ${prodLocation.id} -> ${stagingLocation.id}`,
      );
    } else {
      console.warn(
        `No matching staging location found for: "${prodLocation.name}" (${prodLocation.id})`,
      );
    }
  }

  return locationMap;
}

/**
 * Get inventory levels for a variant across all locations
 * @param {string} inventoryItemId - The inventory item ID
 * @param {Object} admin - Shopify admin API client
 * @returns {Promise<Array>} Array of inventory level objects
 */
export async function getInventoryLevels(inventoryItemId, admin) {
  const query = `
    query GetInventoryLevels($id: ID!) {
      inventoryItem(id: $id) {
        id
        inventoryLevels(first: 100) {
          edges {
            node {
              id
              location {
                id
                name
              }
              quantities(names: ["available", "incoming", "committed", "damaged", "on_hand", "quality_control", "reserved", "safety_stock"]) {
                name
                quantity
              }
            }
          }
        }
      }
    }
  `;

  try {
    const response = await admin.graphql(query, {
      variables: { id: inventoryItemId },
    });
    const result = await response.json();

    if (result.errors) {
      console.error("GraphQL errors fetching inventory levels:", result.errors);
      return [];
    }

    return (
      result.data?.inventoryItem?.inventoryLevels?.edges?.map(
        (edge) => edge.node,
      ) || []
    );
  } catch (error) {
    console.error("Error fetching inventory levels:", error);
    return [];
  }
}
