// Location sync service - handles syncing locations between stores

import { saveMapping, extractIdFromGid } from "./resource-mapping.server.js";

/**
 * Get all locations from production store
 * @param {string} productionStore - The production store domain
 * @param {string} accessToken - The production store access token
 * @returns {Promise<Array>} Array of location objects
 */
async function getProductionLocations(productionStore, accessToken) {
  console.log("Fetching locations from production store...");

  const query = `
    query GetLocations($first: Int!, $after: String) {
      locations(first: $first, after: $after) {
        edges {
          node {
            id
            name
            address {
              address1
              address2
              city
              province
              provinceCode
              country
              countryCode
              zip
              phone
            }
            isActive
            shipsInventory
            fulfillsOnlineOrders
            hasActiveInventory
          }
          cursor
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  `;

  const allLocations = [];
  let hasNextPage = true;
  let cursor = null;

  while (hasNextPage) {
    try {
      const response = await fetch(
        `https://${productionStore}/admin/api/2025-01/graphql.json`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Shopify-Access-Token": accessToken,
          },
          body: JSON.stringify({
            query,
            variables: { first: 50, after: cursor },
          }),
        },
      );

      const data = await response.json();

      if (data.errors) {
        throw new Error(
          `GraphQL errors: ${data.errors.map((e) => e.message).join(", ")}`,
        );
      }

      const locations = data.data.locations.edges.map((edge) => edge.node);
      allLocations.push(...locations);

      hasNextPage = data.data.locations.pageInfo.hasNextPage;
      cursor = data.data.locations.pageInfo.endCursor;
    } catch (error) {
      console.error("Error fetching locations:", error);
      throw error;
    }
  }

  console.log(`Fetched ${allLocations.length} locations from production`);
  return allLocations;
}

/**
 * Get all locations from staging store
 * @param {Object} stagingAdmin - Shopify admin API client for staging
 * @returns {Promise<Array>} Array of location objects
 */
async function getStagingLocations(stagingAdmin) {
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
              provinceCode
              country
              countryCode
              zip
              phone
            }
            isActive
          }
        }
      }
    }
  `;

  try {
    const response = await stagingAdmin.graphql(query, {
      variables: { first: 250 },
    });
    const result = await response.json();

    if (result.errors) {
      throw new Error(
        `GraphQL errors: ${result.errors.map((e) => e.message).join(", ")}`,
      );
    }

    return result.data.locations.edges.map((edge) => edge.node);
  } catch (error) {
    console.error("Error fetching staging locations:", error);
    throw error;
  }
}

/**
 * Create a location in staging
 * @param {Object} location - Location object from production
 * @param {Object} stagingAdmin - Shopify admin API client for staging
 * @returns {Promise<Object>} Created location object
 */
async function createLocationInStaging(location, stagingAdmin) {
  const mutation = `
    mutation locationAdd($input: LocationAddInput!) {
      locationAdd(input: $input) {
        location {
          id
          name
          address {
            address1
            address2
            city
            provinceCode
            countryCode
            zip
            phone
          }
          isActive
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  // Ensure we have a valid countryCode
  if (!location.address.countryCode) {
    throw new Error(`Location "${location.name}" is missing countryCode`);
  }

  const input = {
    name: location.name,
    address: {
      address1: location.address.address1,
      address2: location.address.address2,
      city: location.address.city,
      provinceCode: location.address.provinceCode || null,
      countryCode: location.address.countryCode,
      zip: location.address.zip,
      phone: location.address.phone,
    },
    fulfillsOnlineOrders: location.fulfillsOnlineOrders,
  };

  try {
    const response = await stagingAdmin.graphql(mutation, {
      variables: { input },
    });
    const result = await response.json();

    if (result.errors) {
      throw new Error(
        `GraphQL errors: ${result.errors.map((e) => e.message).join(", ")}`,
      );
    }

    if (result.data?.locationAdd?.userErrors?.length > 0) {
      const errors = result.data.locationAdd.userErrors
        .map((e) => `${e.field}: ${e.message}`)
        .join(", ");
      throw new Error(`Failed to create location: ${errors}`);
    }

    return result.data.locationAdd.location;
  } catch (error) {
    console.error(`Error creating location "${location.name}":`, error);
    throw error;
  }
}

/**
 * Check if locations match (by name and address)
 * @param {Object} prodLocation - Location from production
 * @param {Object} stagingLocation - Location from staging
 * @returns {boolean} True if locations match
 */
function locationsMatch(prodLocation, stagingLocation) {
  // First check if names match exactly
  if (prodLocation.name === stagingLocation.name) {
    return true;
  }

  // Then check if it's the same physical location by address
  return (
    prodLocation.address.address1 === stagingLocation.address.address1 &&
    prodLocation.address.city === stagingLocation.address.city &&
    prodLocation.address.countryCode === stagingLocation.address.countryCode
  );
}

/**
 * Sync locations from production to staging
 * @param {string} productionStore - The production store domain
 * @param {string} accessToken - The production store access token
 * @param {Object} stagingAdmin - Shopify admin API client for staging
 * @param {Function} onProgress - Progress callback function
 * @returns {Promise<Object>} Sync summary
 */
export async function syncLocations(
  productionStore,
  accessToken,
  stagingAdmin,
  storeConnectionId = null,
  onProgress = () => {},
) {
  const summary = {
    total: 0,
    created: 0,
    matched: 0,
    failed: 0,
    errors: [],
  };

  const log = [];

  try {
    // Step 1: Fetch locations from both stores
    onProgress({
      message: "Fetching locations from production...",
      step: 1,
      totalSteps: 4,
    });

    const productionLocations = await getProductionLocations(
      productionStore,
      accessToken,
    );
    summary.total = productionLocations.length;

    log.push({
      timestamp: new Date().toISOString(),
      message: `Found ${productionLocations.length} locations in production`,
    });

    onProgress({
      message: "Fetching locations from staging...",
      step: 2,
      totalSteps: 4,
    });

    const stagingLocations = await getStagingLocations(stagingAdmin);

    log.push({
      timestamp: new Date().toISOString(),
      message: `Found ${stagingLocations.length} locations in staging`,
    });

    // Step 2: Process each production location
    onProgress({
      message: "Syncing locations...",
      step: 3,
      totalSteps: 4,
    });

    for (let i = 0; i < productionLocations.length; i++) {
      const prodLocation = productionLocations[i];

      // Debug log the location data
      console.log(`Processing location: ${prodLocation.name}`, {
        address: prodLocation.address,
        hasCountryCode: !!prodLocation.address.countryCode,
        hasProvinceCode: !!prodLocation.address.provinceCode,
      });

      onProgress({
        message: `Processing location ${i + 1}/${productionLocations.length}: ${prodLocation.name}`,
        step: 3,
        totalSteps: 4,
        current: i + 1,
        total: productionLocations.length,
      });

      // Check if location already exists in staging
      const existingLocation = stagingLocations.find((stagingLoc) =>
        locationsMatch(prodLocation, stagingLoc),
      );

      if (existingLocation) {
        summary.matched++;
        log.push({
          timestamp: new Date().toISOString(),
          message: `✓ Location "${prodLocation.name}" already exists in staging`,
          success: true,
        });

        // Save mapping for matched location
        if (storeConnectionId) {
          try {
            await saveMapping(storeConnectionId, "location", {
              productionId: extractIdFromGid(prodLocation.id),
              stagingId: extractIdFromGid(existingLocation.id),
              productionGid: prodLocation.id,
              stagingGid: existingLocation.id,
              matchKey: "name",
              matchValue: prodLocation.name,
              syncId: null,
              title: prodLocation.name,
            });
            console.log(`✅ Saved mapping for location: ${prodLocation.name}`);
          } catch (mappingError) {
            console.error(
              `⚠️ Failed to save mapping for location ${prodLocation.name}:`,
              mappingError.message,
            );
          }
        }
      } else {
        // Create the location
        try {
          const createdLocation = await createLocationInStaging(
            prodLocation,
            stagingAdmin,
          );
          summary.created++;
          log.push({
            timestamp: new Date().toISOString(),
            message: `✅ Created location: ${prodLocation.name}`,
            success: true,
            details: {
              id: createdLocation.id,
              name: createdLocation.name,
              address: createdLocation.address,
            },
          });

          // Save mapping for created location
          if (storeConnectionId) {
            try {
              await saveMapping(storeConnectionId, "location", {
                productionId: extractIdFromGid(prodLocation.id),
                stagingId: extractIdFromGid(createdLocation.id),
                productionGid: prodLocation.id,
                stagingGid: createdLocation.id,
                matchKey: "name",
                matchValue: prodLocation.name,
                syncId: null,
                title: prodLocation.name,
              });
              console.log(
                `✅ Saved mapping for location: ${prodLocation.name}`,
              );
            } catch (mappingError) {
              console.error(
                `⚠️ Failed to save mapping for location ${prodLocation.name}:`,
                mappingError.message,
              );
            }
          }
        } catch (error) {
          summary.failed++;
          summary.errors.push({
            location: prodLocation.name,
            error: error.message,
          });
          log.push({
            timestamp: new Date().toISOString(),
            message: `❌ Failed to create location: ${prodLocation.name}`,
            error: error.message,
            success: false,
          });
        }
      }
    }

    // Step 3: Complete
    onProgress({
      message: "Location sync completed",
      step: 4,
      totalSteps: 4,
    });

    return {
      success: true,
      summary,
      log,
    };
  } catch (error) {
    console.error("Location sync failed:", error);
    throw error;
  }
}

/**
 * Get location mappings between production and staging
 * @param {string} productionStore - The production store domain
 * @param {string} accessToken - The production store access token
 * @param {Object} stagingAdmin - Shopify admin API client for staging
 * @returns {Promise<Map>} Map of production location IDs to staging location IDs
 */
export async function getLocationMappings(
  productionStore,
  accessToken,
  stagingAdmin,
) {
  const productionLocations = await getProductionLocations(
    productionStore,
    accessToken,
  );
  const stagingLocations = await getStagingLocations(stagingAdmin);

  const mappings = new Map();

  for (const prodLocation of productionLocations) {
    const stagingLocation = stagingLocations.find((stagingLoc) =>
      locationsMatch(prodLocation, stagingLoc),
    );

    if (stagingLocation) {
      mappings.set(prodLocation.id, stagingLocation.id);
    }
  }

  return mappings;
}
