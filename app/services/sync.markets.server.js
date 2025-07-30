/**
 * Market sync service for Shopify stores
 * Syncs markets from production to staging using GraphQL Admin API
 */

/**
 * Get all markets from production store
 * @param {string} productionStore - The production store domain
 * @param {string} accessToken - The production store access token
 * @returns {Promise<Array>} Array of market objects
 */
async function getProductionMarkets(productionStore, accessToken) {
  const query = `
    query GetMarkets($first: Int!) {
      markets(first: $first) {
        edges {
          node {
            id
            handle
            name
            status
            conditions {
              regionsCondition {
                regions(first: 10) {
                  nodes {
                    ... on MarketRegionCountry {
                      code
                      name
                    }
                  }
                }
              }
              companyLocationsCondition {
                companyLocations(first: 10) {
                  nodes {
                    id
                    name
                  }
                }
              }
              locationsCondition {
                locations(first: 10) {
                  nodes {
                    id
                    name
                  }
                }
              }
            }
            currencySettings {
              baseCurrency {
                currencyCode
              }
              localCurrencies
            }
            webPresences(first: 10) {
              nodes {
                id
                subfolderSuffix
                defaultLocale {
                  isoCode
                }
                alternateLocales {
                  isoCode
                }
                domain {
                  id
                  host
                }
              }
            }
          }
        }
      }
    }
  `;

  try {
    const response = await fetch(
      `https://${productionStore}/admin/api/2025-07/graphql.json`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": accessToken,
        },
        body: JSON.stringify({
          query,
          variables: { first: 250 },
        }),
      },
    );

    const data = await response.json();

    if (data.errors) {
      throw new Error(
        `GraphQL errors: ${data.errors.map((e) => e.message).join(", ")}`,
      );
    }

    return data.data.markets.edges.map((edge) => edge.node);
  } catch (error) {
    console.error("Error fetching markets from production:", error);
    throw error;
  }
}

/**
 * Get all markets from staging store
 * @param {Object} stagingAdmin - Shopify admin API client for staging
 * @returns {Promise<Array>} Array of market objects
 */
async function getStagingMarkets(stagingAdmin) {
  const query = `
    query GetStagingMarkets($first: Int!) {
      markets(first: $first) {
        edges {
          node {
            id
            handle
            name
            status
          }
        }
      }
    }
  `;

  try {
    const variables = { first: 250 };
    const response = await stagingAdmin.graphql(query, { variables });
    const result = await response.json();

    if (result.data?.markets?.edges) {
      return result.data.markets.edges.map((edge) => edge.node);
    }

    return [];
  } catch (error) {
    console.error("Error fetching staging markets:", error);
    throw error;
  }
}

/**
 * Check if a market exists in staging by handle
 * @param {string} handle - The market handle
 * @param {Object} stagingAdmin - Shopify admin API client for staging
 * @returns {Promise<Object|null>} Market object if exists, null otherwise
 */
async function getStagingMarketByHandle(handle, stagingAdmin) {
  const query = `
    query GetMarkets($first: Int!) {
      markets(first: $first) {
        edges {
          node {
            id
            handle
            name
            status
          }
        }
      }
    }
  `;

  try {
    const variables = { first: 250 };
    const response = await stagingAdmin.graphql(query, { variables });
    const result = await response.json();

    if (result.errors) {
      console.error("Error getting staging markets:", result.errors);
      return null;
    }

    const markets = result.data?.markets?.edges || [];
    const matchingMarket = markets.find(
      (market) => market.node.handle === handle,
    );
    return matchingMarket ? matchingMarket.node : null;
  } catch (error) {
    console.error("Error getting staging market by handle:", error);
    return null;
  }
}

/**
 * Create a new market in staging
 * @param {Object} market - The market object from production
 * @param {Object} stagingAdmin - Shopify admin API client for staging
 * @returns {Promise<Object>} Result object with success status and market data
 */
async function createMarketInStaging(market, stagingAdmin) {
  console.log("MAAARKET IN FUNCTION", market);
  const mutation = `
    mutation marketCreate($input: MarketCreateInput!) {
      marketCreate(input: $input) {
        market {
          id
          handle
          name
          status
          conditions {
            regionsCondition {
              regions(first: 5) {
                nodes {
                  name
                }
              }
            }
          }
          webPresences(first: 5) {
            nodes {
              id
              subfolderSuffix
              domain {
                host
              }
            }
          }
        }
        userErrors {
          field
          message
          code
        }
      }
    }
  `;

  try {
    // Prepare the input for market creation
    const input = {
      name: market.name,
      handle: market.handle,
      status: market.status || "ACTIVE", // Use status field as shown in GraphQL
    };

    // Add conditions if any exist
    const conditions = {};
    let hasConditions = false;

    // Add regions if they exist
    if (market.conditions?.regionsCondition?.regions?.nodes?.length > 0) {
      conditions.regionsCondition = {
        regions: market.conditions.regionsCondition.regions.nodes.map(
          (region) => ({
            countryCode: region.code,
          }),
        ),
      };
      hasConditions = true;
    }

    // Only add conditions to input if there are any
    if (hasConditions) {
      input.conditions = conditions;
    }

    console.log("MAAARKET", input);
    console.log("MAAARKET REEEGIONS", JSON.stringify(input, null, 2));

    let result;
    try {
      // The Shopify GraphQL client expects variables to be passed in a variables object
      const variables = { input };
      const response = await stagingAdmin.graphql(mutation, { variables });
      result = await response.json();
    } catch (error) {
      console.error("GraphQL Client Error:", error);
      if (error.body?.errors?.graphQLErrors) {
        console.error(
          "GraphQL errors details:",
          JSON.stringify(error.body.errors.graphQLErrors, null, 2),
        );
      }
      throw error;
    }

    // Log the full result for debugging
    console.log(
      `Market creation result for "${market.name}":`,
      JSON.stringify(result, null, 2),
    );

    if (result.errors) {
      console.error(
        "GraphQL errors details:",
        JSON.stringify(result.errors, null, 2),
      );
      const errors = result.errors.map((e) => e.message).join(", ");
      throw new Error(`GraphQL errors: ${errors}`);
    }

    if (result.data?.marketCreate?.userErrors?.length > 0) {
      const errors = result.data.marketCreate.userErrors
        .map((e) => e.message)
        .join(", ");
      throw new Error(
        `Failed to create market "${market.name}" (handle: ${market.handle}): ${errors}`,
      );
    }

    if (!result.data?.marketCreate?.market) {
      throw new Error(
        `Failed to create market "${market.name}" (handle: ${market.handle}): No market returned from API`,
      );
    }

    return {
      success: true,
      market: result.data?.marketCreate?.market,
    };
  } catch (error) {
    console.error(`Error creating market "${market.name}":`, error);
    console.error(`Market data:`, JSON.stringify(market, null, 2));
    return {
      success: false,
      error: error.message || "Unknown error occurred",
    };
  }
}

/**
 * Sync currency settings for a market
 * @param {string} marketId - The market ID in staging
 * @param {Object} currencySettings - The currency settings from production
 * @param {Object} stagingAdmin - Shopify admin API client for staging
 * @returns {Promise<Object>} Result object with success status
 */
async function syncMarketCurrencySettings(marketId, currencySettings, stagingAdmin) {
  if (!currencySettings) {
    return { success: true, message: "No currency settings to sync" };
  }

  const mutation = `
    mutation marketCurrencySettingsUpdate($marketId: ID!, $input: MarketCurrencySettingsUpdateInput!) {
      marketCurrencySettingsUpdate(marketId: $marketId, input: $input) {
        market {
          id
          handle
          currencySettings {
            baseCurrency {
              currencyCode
            }
            localCurrencies
          }
        }
        userErrors {
          field
          message
          code
        }
      }
    }
  `;

  try {
    const input = {
      baseCurrency: currencySettings.baseCurrency?.currencyCode,
      localCurrencies: currencySettings.localCurrencies
    };

    // Only include fields that have values
    const cleanInput = {};
    if (input.baseCurrency) cleanInput.baseCurrency = input.baseCurrency;
    if (typeof input.localCurrencies === 'boolean') cleanInput.localCurrencies = input.localCurrencies;

    const variables = { marketId, input: cleanInput };
    const response = await stagingAdmin.graphql(mutation, { variables });
    const result = await response.json();

    console.log(`Currency settings sync result for market ${marketId}:`, JSON.stringify(result, null, 2));

    if (result.errors) {
      const errors = result.errors.map((e) => e.message).join(", ");
      throw new Error(`GraphQL errors: ${errors}`);
    }

    if (result.data?.marketCurrencySettingsUpdate?.userErrors?.length > 0) {
      const errors = result.data.marketCurrencySettingsUpdate.userErrors
        .map((e) => e.message)
        .join(", ");
      throw new Error(`Failed to update currency settings: ${errors}`);
    }

    return {
      success: true,
      market: result.data?.marketCurrencySettingsUpdate?.market
    };
  } catch (error) {
    console.error(`Error syncing currency settings for market ${marketId}:`, error);
    return {
      success: false,
      error: error.message || "Unknown error occurred"
    };
  }
}

/**
 * Update an existing market in staging
 * @param {string} marketId - The market ID in staging
 * @param {Object} market - The market object from production
 * @param {Object} stagingAdmin - Shopify admin API client for staging
 * @returns {Promise<Object>} Result object with success status and market data
 */
async function updateMarketInStaging(marketId, market, stagingAdmin) {
  const mutation = `
    mutation marketUpdate($id: ID!, $input: MarketUpdateInput!) {
      marketUpdate(id: $id, input: $input) {
        market {
          id
          handle
          name
          status
        }
        userErrors {
          field
          message
          code
        }
      }
    }
  `;

  try {
    // Prepare the input for market update
    const input = {
      name: market.name,
      handle: market.handle,
      status: market.status || "ACTIVE", // Use status field directly
    };

    // Add regions if they exist
    if (market.conditions?.regionsCondition?.regions?.nodes?.length > 0) {
      input.conditions = {
        conditionsToAdd: {
          regionsCondition: {
            regions: market.conditions.regionsCondition.regions.nodes.map(
              (region) => ({
                countryCode: region.code,
              }),
            ),
          },
        },
      };
    }

    // Add company locations if they exist
    if (
      market.conditions?.companyLocationsCondition?.companyLocations?.nodes
        ?.length > 0
    ) {
      if (!input.conditions) input.conditions = {};
      if (!input.conditions.conditionsToAdd)
        input.conditions.conditionsToAdd = {};
      input.conditions.conditionsToAdd.companyLocationsCondition = {
        companyLocationIds:
          market.conditions.companyLocationsCondition.companyLocations.nodes.map(
            (location) => location.id,
          ),
      };
    }

    // Add locations if they exist
    if (market.conditions?.locationsCondition?.locations?.nodes?.length > 0) {
      if (!input.conditions) input.conditions = {};
      if (!input.conditions.conditionsToAdd)
        input.conditions.conditionsToAdd = {};
      input.conditions.conditionsToAdd.locationsCondition = {
        locationIds: market.conditions.locationsCondition.locations.nodes.map(
          (location) => location.id,
        ),
      };
    }

    const variables = {
      id: marketId,
      input,
    };
    const response = await stagingAdmin.graphql(mutation, { variables });
    const result = await response.json();

    // Log the full result for debugging
    console.log(
      `Market update result for "${market.name}":`,
      JSON.stringify(result, null, 2),
    );

    if (result.errors) {
      const errors = result.errors.map((e) => e.message).join(", ");
      throw new Error(`GraphQL errors: ${errors}`);
    }

    if (result.data?.marketUpdate?.userErrors?.length > 0) {
      const errors = result.data.marketUpdate.userErrors
        .map((e) => e.message)
        .join(", ");
      throw new Error(
        `Failed to update market "${market.name}" (handle: ${market.handle}): ${errors}`,
      );
    }

    if (!result.data?.marketUpdate?.market) {
      throw new Error(
        `Failed to update market "${market.name}" (handle: ${market.handle}): No market returned from API`,
      );
    }

    return {
      success: true,
      market: result.data?.marketUpdate?.market,
    };
  } catch (error) {
    console.error(`Error updating market "${market.name}":`, error);
    console.error(`Market data:`, JSON.stringify(market, null, 2));
    return {
      success: false,
      error: error.message || "Unknown error occurred",
    };
  }
}

/**
 * Sync markets from production to staging
 * @param {string} productionStore - The production store domain
 * @param {string} accessToken - The production store access token
 * @param {Object} stagingAdmin - Shopify admin API client for staging
 * @param {Function} onProgress - Progress callback function
 * @returns {Promise<Object>} Sync summary
 */
export async function syncMarkets(
  productionStore,
  accessToken,
  stagingAdmin,
  onProgress = () => {},
) {
  const log = [];
  const summary = {
    total: 0,
    created: 0,
    updated: 0,
    skipped: 0,
    failed: 0,
    errors: [],
  };

  try {
    // Step 1: Fetch all markets from production
    log.push({
      timestamp: new Date().toISOString(),
      message: "Fetching markets from production store...",
    });

    onProgress({
      stage: "fetching",
      message: "Fetching markets from production...",
      percentage: 0,
    });

    const productionMarkets = await getProductionMarkets(
      productionStore,
      accessToken,
    );

    console.log("productionMarkets", productionMarkets);

    summary.total = productionMarkets.length;

    log.push({
      timestamp: new Date().toISOString(),
      message: `Found ${productionMarkets.length} markets`,
    });

    if (productionMarkets.length === 0) {
      return { summary, log };
    }

    // Step 2: Process each market
    onProgress({
      stage: "processing",
      message: "Processing markets...",
      percentage: 10,
    });

    for (let i = 0; i < productionMarkets.length; i++) {
      const market = productionMarkets[i];
      const progress = 10 + Math.round((i / productionMarkets.length) * 80);

      onProgress({
        stage: "processing",
        message: `Processing market: ${market.name}`,
        percentage: progress,
      });

      log.push({
        timestamp: new Date().toISOString(),
        message: `Processing market: ${market.name} (handle: ${market.handle})`,
      });

      // Check if market already exists in staging
      const existingMarket = await getStagingMarketByHandle(
        market.handle,
        stagingAdmin,
      );

      if (existingMarket) {
        // Update existing market
        log.push({
          timestamp: new Date().toISOString(),
          message: `Updating existing market: ${market.name}`,
        });

        const result = await updateMarketInStaging(
          existingMarket.id,
          market,
          stagingAdmin,
        );

        if (result.success) {
          summary.updated++;
          log.push({
            timestamp: new Date().toISOString(),
            message: `✅ Successfully updated market: ${market.name}`,
            success: true,
          });
        } else {
          summary.failed++;
          const errorMessage = `Failed to update market "${market.name}" (handle: ${market.handle}): ${result.error}`;
          summary.errors.push(errorMessage);
          log.push({
            timestamp: new Date().toISOString(),
            message: `❌ ${errorMessage}`,
            success: false,
            error: result.error,
          });
        }
      } else {
        // Create new market
        log.push({
          timestamp: new Date().toISOString(),
          message: `Creating new market: ${market.name}`,
        });

        const result = await createMarketInStaging(market, stagingAdmin);

        if (result.success) {
          summary.created++;
          log.push({
            timestamp: new Date().toISOString(),
            message: `✅ Successfully created market: ${market.name}`,
            success: true,
          });
        } else {
          summary.failed++;
          const errorMessage = `Failed to create market "${market.name}" (handle: ${market.handle}): ${result.error}`;
          summary.errors.push(errorMessage);
          log.push({
            timestamp: new Date().toISOString(),
            message: `❌ ${errorMessage}`,
            success: false,
            error: result.error,
          });
        }
      }
    }

    // Step 3: Finalize
    onProgress({
      stage: "completed",
      message: "Market sync completed",
      percentage: 100,
    });

    log.push({
      timestamp: new Date().toISOString(),
      message: `Market sync completed. Created: ${summary.created}, Updated: ${summary.updated}, Failed: ${summary.failed}`,
    });

    return { summary, log };
  } catch (error) {
    console.error("Error syncing markets:", error);

    const errorMessage = `Market sync failed: ${error.message}`;
    summary.errors.push(errorMessage);
    log.push({
      timestamp: new Date().toISOString(),
      message: `❌ ${errorMessage}`,
      success: false,
      error: error.message,
    });

    return { summary, log };
  }
}
