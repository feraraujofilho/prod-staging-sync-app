/**
 * Market sync service for Shopify stores
 * Syncs markets from production to staging using GraphQL Admin API
 */

import {
  syncMetafieldValues,
  syncMetafieldDefinitions,
} from "./sync.metafields.server.js";
import { saveMapping, extractIdFromGid } from "./resource-mapping.server.js";

/**
 * Fetch the primary catalog and curated product handles for a production market.
 * Returns { title, status, currency, productHandles } or null if none.
 */
async function getProductionMarketCatalog(
  productionStore,
  accessToken,
  marketId,
) {
  const query = `
    query GetMarketCatalog($id: ID!, $after: String) {
      market(id: $id) {
        catalogs(first: 5) {
          nodes {
            id
            title
            status
            priceList { currency }
            publication {
              id
              products(first: 250, after: $after) {
                nodes { id handle }
                pageInfo { hasNextPage endCursor }
              }
            }
          }
        }
      }
    }
  `;

  try {
    // First request to get catalog metadata and first page of products
    let after = null;
    let productHandles = [];
    let chosenCatalog = null;

    // We may need more than one request to paginate products.
    while (true) {
      const response = await fetch(
        `https://${productionStore}/admin/api/2025-07/graphql.json`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Shopify-Access-Token": accessToken,
          },
          body: JSON.stringify({ query, variables: { id: marketId, after } }),
        },
      );

      const data = await response.json();
      if (data.errors) {
        const msg = data.errors.map((e) => e.message).join(", ");
        throw new Error(`GraphQL errors: ${msg}`);
      }

      const catalogs = data.data?.market?.catalogs?.nodes || [];
      if (!chosenCatalog) {
        // prefer ACTIVE catalog, else first
        chosenCatalog =
          catalogs.find((c) => c.status === "ACTIVE") || catalogs[0] || null;
        if (!chosenCatalog) return null;
      }

      const currentProducts = chosenCatalog.publication?.products;
      if (currentProducts?.nodes?.length) {
        productHandles.push(
          ...currentProducts.nodes.map((p) => p.handle).filter(Boolean),
        );
      }

      const pageInfo = currentProducts?.pageInfo;
      if (pageInfo?.hasNextPage) {
        after = pageInfo.endCursor;
        // loop continues with updated cursor
      } else {
        break;
      }
    }

    return {
      title: chosenCatalog.title,
      status: chosenCatalog.status,
      currency: chosenCatalog.priceList?.currency || null,
      productHandles,
    };
  } catch (error) {
    console.warn(
      `[MARKETS DEBUG] Failed to read production catalog for market ${marketId}:`,
      error.message,
    );
    return null;
  }
}

/**
 * Resolve product IDs in staging by handles.
 */
async function resolveStagingProductIdsByHandles(stagingAdmin, handles) {
  if (!handles || handles.length === 0) return [];

  const ids = [];
  const BATCH_SIZE = 50;

  // Process handles in batches using GraphQL aliases
  for (let i = 0; i < handles.length; i += BATCH_SIZE) {
    const batch = handles.slice(i, i + BATCH_SIZE);

    // Build aliased query: p0: productByIdentifier(...) { id }, p1: ...
    const fragments = batch
      .map(
        (handle, idx) =>
          `p${idx}: productByIdentifier(identifier: { handle: "${handle.replace(/"/g, '\\"')}" }) { id }`,
      )
      .join("\n      ");

    const query = `query { ${fragments} }`;

    try {
      const resp = await stagingAdmin.graphql(query);
      const json = await resp.json();

      if (json.errors) {
        console.warn(
          `[MARKETS DEBUG] Batch resolve errors:`,
          json.errors.map((e) => e.message).join(", "),
        );
      }

      // Extract IDs from aliased results
      for (let idx = 0; idx < batch.length; idx++) {
        const id = json.data?.[`p${idx}`]?.id;
        if (id) ids.push(id);
      }
    } catch (e) {
      console.warn(
        `[MARKETS DEBUG] Batch resolve failed, falling back to individual queries:`,
        e.message,
      );
      // Fallback: resolve individually for this batch
      for (const handle of batch) {
        const q = `
          query($handle: String!) {
            product: productByIdentifier(identifier:{ handle: $handle }) { id }
          }
        `;
        try {
          const resp = await stagingAdmin.graphql(q, { variables: { handle } });
          const json = await resp.json();
          const id = json.data?.product?.id;
          if (id) ids.push(id);
        } catch (innerErr) {
          console.warn(
            `[MARKETS DEBUG] Failed to resolve handle ${handle}:`,
            innerErr.message,
          );
        }
      }
    }
  }

  return ids;
}

/**
 * Create a catalog on staging for a market, attach a publication and price list,
 * and populate the curated product set.
 */
async function ensureStagingCatalogWithCuratedPublication(
  stagingAdmin,
  marketId,
  marketName,
  baseCurrencyCode,
  productHandles,
) {
  // Create catalog (assign directly to market context)
  const catalogCreate = `
    mutation($title:String!, $marketId:ID!) {
      catalogCreate(input:{ title:$title, status: ACTIVE, context:{ marketIds: [$marketId] }}) {
        catalog { id title status }
        userErrors { field message code }
      }
    }
  `;

  const title = `Synced ${marketName}`.slice(0, 60);
  const catalogResp = await stagingAdmin.graphql(catalogCreate, {
    variables: { title, marketId },
  });
  const catalogJson = await catalogResp.json();
  if (catalogJson.data?.catalogCreate?.userErrors?.length) {
    const msg = catalogJson.data.catalogCreate.userErrors
      .map((e) => e.message)
      .join(", ");
    console.warn(
      `[MARKETS DEBUG] catalogCreate errors for ${marketName}:`,
      msg,
    );
  }
  const catalogId = catalogJson.data?.catalogCreate?.catalog?.id;
  if (!catalogId) {
    return { success: false, error: "Failed to create catalog" };
  }

  console.log(`[MARKETS DEBUG] Created catalog ${catalogId} for ${marketName}`);

  // Create publication with NONE default state (curated)
  const publicationCreate = `
    mutation($catalogId:ID!) {
      publicationCreate(input:{ catalogId: $catalogId, defaultState: NONE, autoPublish: true }) {
        publication { id }
        userErrors { field message }
      }
    }
  `;
  const pubResp = await stagingAdmin.graphql(publicationCreate, {
    variables: { catalogId },
  });
  const pubJson = await pubResp.json();
  const publicationId = pubJson.data?.publicationCreate?.publication?.id;
  if (!publicationId) {
    return { success: false, error: "Failed to create publication" };
  }

  // Create a price list (optional but explicit) – requires currency match
  if (baseCurrencyCode) {
    const priceListCreate = `
      mutation($name:String!, $currency:CurrencyCode!, $catalogId:ID!) {
        priceListCreate(input:{ name:$name, currency:$currency, catalogId:$catalogId }) {
          priceList { id }
          userErrors { field message }
        }
      }
    `;
    const plResp = await stagingAdmin.graphql(priceListCreate, {
      variables: {
        name: `${marketName} prices`.slice(0, 60),
        currency: baseCurrencyCode,
        catalogId,
      },
    });
    const plJson = await plResp.json();
    if (plJson.data?.priceListCreate?.userErrors?.length) {
      console.warn(
        `[MARKETS DEBUG] priceListCreate errors for ${marketName}:`,
        plJson.data.priceListCreate.userErrors.map((e) => e.message).join(", "),
      );
    }
  }

  // Resolve staging product IDs by handle and publish in chunks
  const stagingIds = await resolveStagingProductIdsByHandles(
    stagingAdmin,
    productHandles,
  );
  console.log(
    `[MARKETS DEBUG] Resolved ${stagingIds.length}/${productHandles.length} products for ${marketName}`,
  );

  const chunk = (arr, size) =>
    arr.reduce(
      (acc, _, i) => (i % size ? acc : [...acc, arr.slice(i, i + size)]),
      [],
    );
  const chunks = chunk(stagingIds, 200);

  const publicationUpdate = `
    mutation($id:ID!, $ids:[ID!]!) {
      publicationUpdate(id:$id, input:{ publishablesToAdd: $ids }) {
        userErrors { field message }
      }
    }
  `;
  for (const ids of chunks) {
    const uResp = await stagingAdmin.graphql(publicationUpdate, {
      variables: { id: publicationId, ids },
    });
    const uJson = await uResp.json();
    if (uJson.data?.publicationUpdate?.userErrors?.length) {
      console.warn(
        `[MARKETS DEBUG] publicationUpdate errors:`,
        uJson.data.publicationUpdate.userErrors
          .map((e) => e.message)
          .join(", "),
      );
    }
  }

  return {
    success: true,
    catalogId,
    publicationId,
    published: stagingIds.length,
  };
}

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
                  locale
                }
                alternateLocales {
                  locale
                }
                domain {
                  id
                  host
                }
              }
            }
            metafields(first: 50) {
              nodes {
                id
                namespace
                key
                value
                type
                description
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
 * Determine if a market supports currency settings based on its conditions
 * @param {Object} marketConditions - The market conditions object
 * @returns {boolean} True if market supports currency settings
 */
function marketSupportsCurrencySettings(marketConditions) {
  if (!marketConditions) return false;

  // Region markets and B2B markets support currency settings
  // Retail/location markets inherit currency from regions
  return (
    marketConditions.regionsCondition?.regions?.nodes?.length > 0 ||
    marketConditions.companyLocationsCondition?.companyLocations?.nodes
      ?.length > 0
  );
}

/**
 * Sync currency settings for a market
 * @param {string} marketId - The market ID in staging
 * @param {Object} currencySettings - The currency settings from production
 * @param {Object} marketConditions - The market conditions to determine if currency sync is supported
 * @param {Object} stagingAdmin - Shopify admin API client for staging
 * @returns {Promise<Object>} Result object with success status
 */
async function syncMarketCurrencySettings(
  marketId,
  currencySettings,
  marketConditions,
  stagingAdmin,
) {
  if (!currencySettings) {
    return { success: true, message: "No currency settings to sync" };
  }

  // Check if this market type supports currency settings
  if (!marketSupportsCurrencySettings(marketConditions)) {
    return {
      success: true,
      skipped: true,
      message:
        "Currency settings skipped - this market type inherits currency from regions",
    };
  }

  const mutation = `
    mutation marketUpdate($id: ID!, $input: MarketUpdateInput!) {
      marketUpdate(id: $id, input: $input) {
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
    // Build currency settings input for marketUpdate
    const currencySettingsInput = {};

    if (currencySettings.baseCurrency?.currencyCode) {
      currencySettingsInput.baseCurrency =
        currencySettings.baseCurrency.currencyCode;
    }

    if (typeof currencySettings.localCurrencies === "boolean") {
      currencySettingsInput.localCurrencies = currencySettings.localCurrencies;
    }

    // Only proceed if we have currency settings to update
    if (Object.keys(currencySettingsInput).length === 0) {
      return { success: true, message: "No currency settings to update" };
    }

    const input = {
      currencySettings: currencySettingsInput,
    };

    const variables = { id: marketId, input };
    const response = await stagingAdmin.graphql(mutation, { variables });
    const result = await response.json();

    console.log(
      `Currency settings sync result for market ${marketId}:`,
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

      // Handle known unified markets restriction
      if (
        errors.includes("unified markets is enabled") ||
        errors.includes("action is restricted")
      ) {
        return {
          success: true,
          skipped: true,
          message:
            "Currency settings skipped - unified markets enabled (currency managed centrally)",
        };
      }

      throw new Error(`Failed to update currency settings: ${errors}`);
    }

    return {
      success: true,
      market: result.data?.marketUpdate?.market,
    };
  } catch (error) {
    console.error(
      `Error syncing currency settings for market ${marketId}:`,
      error,
    );

    // Handle unified markets restriction gracefully
    if (
      error.message?.includes("unified markets is enabled") ||
      error.message?.includes("action is restricted")
    ) {
      return {
        success: true,
        skipped: true,
        message:
          "Currency settings skipped - unified markets enabled (currency managed centrally)",
      };
    }

    return {
      success: false,
      error: error.message || "Unknown error occurred",
    };
  }
}

/**
 * Enable and publish a locale in the staging store
 * @param {string} locale - The locale code (e.g., 'pt-BR', 'fr', 'de')
 * @param {Object} stagingAdmin - Shopify admin API client for staging
 * @returns {Promise<Object>} Result object with success status
 */
async function enableAndPublishLocale(locale, stagingAdmin) {
  try {
    // First, enable the locale
    const enableMutation = `
      mutation shopLocaleEnable($locale: String!) {
        shopLocaleEnable(locale: $locale) {
          shopLocale {
            locale
            name
            published
          }
          userErrors {
            field
            message
          }
        }
      }
    `;

    const enableResponse = await stagingAdmin.graphql(enableMutation, {
      variables: { locale },
    });
    const enableResult = await enableResponse.json();

    if (enableResult.data?.shopLocaleEnable?.userErrors?.length > 0) {
      const errors = enableResult.data.shopLocaleEnable.userErrors
        .map((e) => e.message)
        .join(", ");

      // If locale is already enabled or is the primary locale, treat as no-op
      if (
        !errors.includes("already enabled") &&
        !errors.includes("already exists") &&
        !errors.toLowerCase().includes("primary locale") &&
        !errors.toLowerCase().includes("can't be changed")
      ) {
        return {
          success: false,
          error: `Failed to enable locale ${locale}: ${errors}`,
        };
      }
    }

    // Then, publish the locale
    const publishMutation = `
      mutation shopLocaleUpdate($locale: String!, $shopLocale: ShopLocaleInput!) {
        shopLocaleUpdate(locale: $locale, shopLocale: $shopLocale) {
          shopLocale {
            name
            locale
            primary
            published
          }
          userErrors {
            field
            message
          }
        }
      }
    `;

    const publishResponse = await stagingAdmin.graphql(publishMutation, {
      variables: {
        locale,
        shopLocale: { published: true },
      },
    });
    const publishResult = await publishResponse.json();

    if (publishResult.data?.shopLocaleUpdate?.userErrors?.length > 0) {
      const errors = publishResult.data.shopLocaleUpdate.userErrors
        .map((e) => e.message)
        .join(", ");
      // Primary locale cannot be changed via endpoint; treat as no-op
      if (
        errors.toLowerCase().includes("primary locale") ||
        errors.toLowerCase().includes("can't be changed")
      ) {
        return { success: true, locale };
      }
      return {
        success: false,
        error: `Failed to publish locale ${locale}: ${errors}`,
      };
    }

    return { success: true, locale };
  } catch (error) {
    console.error(`Error enabling/publishing locale ${locale}:`, error);
    return { success: false, error: error.message };
  }
}

/**
 * Sync web presences for a market
 * @param {string} marketId - The market ID in staging
 * @param {Array} webPresences - The web presences from production
 * @param {Object} stagingAdmin - Shopify admin API client for staging
 * @returns {Promise<Object>} Result object with success status
 */
async function syncMarketWebPresences(marketId, webPresences, stagingAdmin) {
  if (!webPresences || webPresences.length === 0) {
    return { success: true, message: "No web presences to sync" };
  }

  const results = {
    success: true,
    created: 0,
    updated: 0,
    failed: 0,
    errors: [],
  };

  // First, get existing web presences for this market
  const getExistingQuery = `
    query getMarketWebPresences($marketId: ID!) {
      market(id: $marketId) {
        webPresences(first: 10) {
          nodes {
            id
            subfolderSuffix
            defaultLocale {
              locale
            }
            domain {
              id
              host
            }
          }
        }
      }
    }
  `;

  try {
    const existingResponse = await stagingAdmin.graphql(getExistingQuery, {
      variables: { marketId },
    });
    const existingResult = await existingResponse.json();
    const existingWebPresences =
      existingResult.data?.market?.webPresences?.nodes || [];

    // Step 1: Collect all required locales from all web presences
    const allRequiredLocales = new Set();
    webPresences.forEach((webPresence) => {
      if (webPresence.defaultLocale?.locale) {
        allRequiredLocales.add(webPresence.defaultLocale.locale);
      }
      if (webPresence.alternateLocales) {
        webPresence.alternateLocales.forEach((locale) => {
          if (locale.locale) {
            allRequiredLocales.add(locale.locale);
          }
        });
      }
    });

    // Step 2: Enable and publish all required locales
    const localeResults = [];
    for (const locale of allRequiredLocales) {
      const localeResult = await enableAndPublishLocale(locale, stagingAdmin);
      localeResults.push({ locale, ...localeResult });

      if (localeResult.success) {
        console.log(`✅ Successfully enabled and published locale: ${locale}`);
      } else {
        console.log(
          `⚠️ Failed to enable/publish locale ${locale}: ${localeResult.error}`,
        );
      }
    }

    // Step 3: Process each web presence from production
    for (const webPresence of webPresences) {
      try {
        // Check if web presence already exists (match by subfolderSuffix and domain)
        const existingWebPresence = existingWebPresences.find(
          (existing) =>
            existing.subfolderSuffix === webPresence.subfolderSuffix &&
            existing.domain?.host === webPresence.domain?.host,
        );

        const webPresenceInput = {
          defaultLocale: webPresence.defaultLocale?.locale,
          alternateLocales:
            webPresence.alternateLocales?.map((locale) => locale.locale) || [],
          subfolderSuffix: webPresence.subfolderSuffix,
        };

        // Note: We skip domainId since staging domains will be different
        // The web presence will use the default domain of the staging store

        if (existingWebPresence) {
          // Update existing web presence
          const updateMutation = `
            mutation marketWebPresenceUpdate($webPresenceId: ID!, $webPresence: MarketWebPresenceUpdateInput!) {
              marketWebPresenceUpdate(webPresenceId: $webPresenceId, webPresence: $webPresence) {
                market {
                  id
                }
                userErrors {
                  field
                  message
                  code
                }
              }
            }
          `;

          const updateResponse = await stagingAdmin.graphql(updateMutation, {
            variables: {
              webPresenceId: existingWebPresence.id,
              webPresence: webPresenceInput,
            },
          });
          const updateResult = await updateResponse.json();

          if (
            updateResult.data?.marketWebPresenceUpdate?.userErrors?.length > 0
          ) {
            const errors = updateResult.data.marketWebPresenceUpdate.userErrors
              .map((e) => e.message)
              .join(", ");
            results.errors.push(`Failed to update web presence: ${errors}`);
            results.failed++;
          } else {
            results.updated++;
          }
        } else {
          // Create new web presence
          const createMutation = `
            mutation marketWebPresenceCreate($marketId: ID!, $webPresence: MarketWebPresenceCreateInput!) {
              marketWebPresenceCreate(marketId: $marketId, webPresence: $webPresence) {
                market {
                  id
                }
                userErrors {
                  field
                  message
                  code
                }
              }
            }
          `;

          const createResponse = await stagingAdmin.graphql(createMutation, {
            variables: {
              marketId,
              webPresence: webPresenceInput,
            },
          });
          const createResult = await createResponse.json();

          if (
            createResult.data?.marketWebPresenceCreate?.userErrors?.length > 0
          ) {
            const errors = createResult.data.marketWebPresenceCreate.userErrors
              .map((e) => e.message)
              .join(", ");
            results.errors.push(`Failed to create web presence: ${errors}`);
            results.failed++;
          } else {
            results.created++;
          }
        }
      } catch (error) {
        console.error(`Error processing web presence:`, error);
        results.errors.push(`Web presence processing error: ${error.message}`);
        results.failed++;
      }
    }

    if (results.failed > 0) {
      results.success = false;
    }

    return results;
  } catch (error) {
    console.error(`Error syncing web presences for market ${marketId}:`, error);
    return {
      success: false,
      error: error.message || "Unknown error occurred",
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

    // Skip company locations and regular locations for market updates
    // These IDs are environment-specific and won't exist in staging
    // Only regions (countries) can be safely synced between environments

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
  storeConnectionId = null,
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
    // Add initial summary log
    log.push({
      timestamp: new Date().toISOString(),
      message: "🚀 Starting markets sync operation",
      type: "sync_start",
      details: {
        productionStore,
        timestamp: new Date().toISOString(),
        operation: "markets_sync",
      },
    });

    // Step 1: Fetch all markets from production
    log.push({
      timestamp: new Date().toISOString(),
      message: "📥 Fetching markets from production store...",
      type: "data_fetch",
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

    // Step 2: Sync metafield definitions for MARKET owner type
    log.push({
      timestamp: new Date().toISOString(),
      message:
        "🔧 Syncing market metafield definitions before processing markets...",
      type: "metafield_definitions_sync",
    });

    onProgress({
      stage: "metafield_definitions",
      message: "Syncing market metafield definitions...",
      percentage: 5,
    });

    try {
      const metafieldDefinitionsResult = await syncMetafieldDefinitions(
        productionStore,
        accessToken,
        stagingAdmin,
        "MARKET", // Only sync MARKET metafield definitions
      );

      if (metafieldDefinitionsResult.success) {
        log.push({
          timestamp: new Date().toISOString(),
          message: `✅ Successfully synced market metafield definitions`,
          type: "metafield_definitions_sync",
          success: true,
          details: {
            created: metafieldDefinitionsResult.summary?.created || 0,
            existing: metafieldDefinitionsResult.summary?.existing || 0,
            skipped: metafieldDefinitionsResult.summary?.skipped || 0,
            failed: metafieldDefinitionsResult.summary?.failed || 0,
          },
        });
      } else {
        log.push({
          timestamp: new Date().toISOString(),
          message: `⚠️ Metafield definitions sync had issues: ${metafieldDefinitionsResult.error || "Unknown error"}`,
          type: "metafield_definitions_sync",
          success: false,
          error: metafieldDefinitionsResult.error,
        });
      }
    } catch (error) {
      log.push({
        timestamp: new Date().toISOString(),
        message: `❌ Failed to sync metafield definitions: ${error.message}`,
        type: "metafield_definitions_sync",
        success: false,
        error: error.message,
      });
    }

    // Step 3: Process each market
    onProgress({
      stage: "processing",
      message: "Processing markets...",
      percentage: 15,
    });

    for (let i = 0; i < productionMarkets.length; i++) {
      const market = productionMarkets[i];
      const progress = 15 + Math.round((i / productionMarkets.length) * 75);

      onProgress({
        stage: "processing",
        message: `Processing market: ${market.name}`,
        percentage: progress,
      });

      log.push({
        timestamp: new Date().toISOString(),
        message: `📋 Processing market: ${market.name} (handle: ${market.handle})`,
        details: {
          marketId: market.id,
          status: market.status,
          regions:
            market.conditions?.regionsCondition?.regions?.nodes?.length || 0,
          webPresences: market.webPresences?.nodes?.length || 0,
          metafields: market.metafields?.nodes?.length || 0,
          currencySettings: market.currencySettings
            ? {
                baseCurrency:
                  market.currencySettings.baseCurrency?.currencyCode,
                localCurrencies: market.currencySettings.localCurrencies,
              }
            : null,
        },
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

          // Save mapping for updated market
          if (storeConnectionId) {
            try {
              await saveMapping(storeConnectionId, "market", {
                productionId: extractIdFromGid(market.id),
                stagingId: extractIdFromGid(existingMarket.id),
                productionGid: market.id,
                stagingGid: existingMarket.id,
                matchKey: "handle",
                matchValue: market.handle,
                syncId: null,
                title: market.name,
              });
              console.log(`✅ Saved mapping for market: ${market.handle}`);
            } catch (mappingError) {
              console.error(
                `⚠️ Failed to save mapping for market ${market.handle}:`,
                mappingError.message,
              );
            }
          }

          // Sync currency settings after successful market update
          if (market.currencySettings) {
            log.push({
              timestamp: new Date().toISOString(),
              message: `💱 Syncing currency settings for market: ${market.name}`,
              details: {
                baseCurrency:
                  market.currencySettings.baseCurrency?.currencyCode,
                localCurrencies: market.currencySettings.localCurrencies,
                marketSupportsSettings: marketSupportsCurrencySettings(
                  market.conditions,
                ),
              },
            });

            const currencyResult = await syncMarketCurrencySettings(
              existingMarket.id,
              market.currencySettings,
              market.conditions,
              stagingAdmin,
            );

            if (currencyResult.success) {
              if (currencyResult.skipped) {
                log.push({
                  timestamp: new Date().toISOString(),
                  message: `⚠️ Currency settings skipped for market "${market.name}": ${currencyResult.message}`,
                  type: "currency_sync",
                  skipped: true,
                  details: { reason: currencyResult.message },
                });
              } else {
                log.push({
                  timestamp: new Date().toISOString(),
                  message: `✅ Successfully synced currency settings for market: ${market.name}`,
                  type: "currency_sync",
                  success: true,
                  details: {
                    baseCurrency:
                      market.currencySettings.baseCurrency?.currencyCode,
                    localCurrencies: market.currencySettings.localCurrencies,
                  },
                });
              }
            } else {
              summary.errors.push(
                `Currency sync failed for "${market.name}": ${currencyResult.error}`,
              );
              log.push({
                timestamp: new Date().toISOString(),
                message: `❌ Currency sync failed for market "${market.name}": ${currencyResult.error}`,
                type: "currency_sync",
                success: false,
                error: currencyResult.error,
              });
            }
          }

          // Sync web presences after successful market update
          if (market.webPresences?.nodes?.length > 0) {
            const webPresenceDetails = market.webPresences.nodes.map((wp) => ({
              subfolderSuffix: wp.subfolderSuffix,
              defaultLocale: wp.defaultLocale?.locale,
              alternateLocales: wp.alternateLocales?.map((l) => l.locale) || [],
              domain: wp.domain?.host,
            }));

            log.push({
              timestamp: new Date().toISOString(),
              message: `🌐 Syncing web presences and locales for market: ${market.name}`,
              type: "web_presence_sync",
              details: {
                count: market.webPresences.nodes.length,
                webPresences: webPresenceDetails,
              },
            });

            const webPresenceResult = await syncMarketWebPresences(
              existingMarket.id,
              market.webPresences.nodes,
              stagingAdmin,
            );

            if (webPresenceResult.success) {
              log.push({
                timestamp: new Date().toISOString(),
                message: `✅ Successfully synced ${webPresenceResult.created + webPresenceResult.updated} web presences for market: ${market.name}`,
                type: "web_presence_sync",
                success: true,
                details: {
                  created: webPresenceResult.created,
                  updated: webPresenceResult.updated,
                  failed: webPresenceResult.failed,
                  total: webPresenceResult.created + webPresenceResult.updated,
                },
              });
            } else {
              summary.errors.push(
                `Web presence sync failed for "${market.name}": ${webPresenceResult.error || webPresenceResult.errors?.join(", ")}`,
              );
              log.push({
                timestamp: new Date().toISOString(),
                message: `❌ Web presence sync failed for market "${market.name}"`,
                type: "web_presence_sync",
                success: false,
                error:
                  webPresenceResult.error ||
                  webPresenceResult.errors?.join(", "),
                details: {
                  errors: webPresenceResult.errors || [],
                },
              });
            }
          }

          // Sync metafields after successful market update
          if (market.metafields?.nodes?.length > 0) {
            const metafieldDetails = market.metafields.nodes.map((mf) => ({
              namespace: mf.namespace,
              key: mf.key,
              type: mf.type,
              valuePreview:
                mf.value?.length > 50
                  ? mf.value.substring(0, 50) + "..."
                  : mf.value,
            }));

            log.push({
              timestamp: new Date().toISOString(),
              message: `🏷️ Syncing metafields for market: ${market.name}`,
              type: "metafields_sync",
              details: {
                count: market.metafields.nodes.length,
                metafields: metafieldDetails,
              },
            });

            const metafieldsResult = await syncMetafieldValues(
              existingMarket.id,
              "MARKET",
              market.metafields.nodes,
              stagingAdmin,
            );

            if (metafieldsResult.success) {
              log.push({
                timestamp: new Date().toISOString(),
                message: `✅ Successfully synced ${metafieldsResult.created + metafieldsResult.updated} metafields for market: ${market.name}`,
                type: "metafields_sync",
                success: true,
                details: {
                  created: metafieldsResult.created,
                  updated: metafieldsResult.updated,
                  skipped: metafieldsResult.skipped,
                  failed: metafieldsResult.failed,
                  total: metafieldsResult.created + metafieldsResult.updated,
                  errors: metafieldsResult.errors || [],
                },
              });
            } else {
              summary.errors.push(
                `Metafields sync failed for "${market.name}": ${metafieldsResult.error || metafieldsResult.errors?.join(", ")}`,
              );
              log.push({
                timestamp: new Date().toISOString(),
                message: `❌ Metafields sync failed for market "${market.name}"`,
                type: "metafields_sync",
                success: false,
                error:
                  metafieldsResult.error || metafieldsResult.errors?.join(", "),
                details: {
                  errors: metafieldsResult.errors || [],
                },
              });
            }
          }

          // Unified Markets: create curated catalog mirroring production publication (subfolders only)
          try {
            const featuresQuery = `query { shop { features { unifiedMarkets } } }`;
            const featResp = await stagingAdmin.graphql(featuresQuery);
            const featJson = await featResp.json();
            const isUnified = !!featJson.data?.shop?.features?.unifiedMarkets;
            console.log(`[MARKETS DEBUG] unifiedMarkets: ${isUnified}`);
            if (isUnified) {
              const prodCat = await getProductionMarketCatalog(
                productionStore,
                accessToken,
                market.id,
              );
              if (prodCat) {
                console.log(
                  `[MARKETS DEBUG] Production catalog for ${market.name}:`,
                  {
                    title: prodCat.title,
                    currency: prodCat.currency,
                    products: prodCat.productHandles.length,
                  },
                );
                const ensureRes =
                  await ensureStagingCatalogWithCuratedPublication(
                    stagingAdmin,
                    existingMarket.id,
                    market.name,
                    prodCat.currency,
                    prodCat.productHandles,
                  );
                if (!ensureRes.success) {
                  console.warn(
                    `[MARKETS DEBUG] Failed to ensure curated catalog for ${market.name}:`,
                    ensureRes.error,
                  );
                } else {
                  console.log(
                    `[MARKETS DEBUG] Curated catalog created for ${market.name}:`,
                    ensureRes,
                  );
                }
              } else {
                console.log(
                  `[MARKETS DEBUG] No production catalog found for ${market.name}; skipping curated publication sync`,
                );
              }
            }
          } catch (e) {
            console.warn(
              `[MARKETS DEBUG] Catalog sync error for ${market.name}:`,
              e.message,
            );
          }
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

          // Save mapping for created market
          if (storeConnectionId) {
            try {
              await saveMapping(storeConnectionId, "market", {
                productionId: extractIdFromGid(market.id),
                stagingId: extractIdFromGid(result.market.id),
                productionGid: market.id,
                stagingGid: result.market.id,
                matchKey: "handle",
                matchValue: market.handle,
                syncId: null,
                title: market.name,
              });
              console.log(`✅ Saved mapping for market: ${market.handle}`);
            } catch (mappingError) {
              console.error(
                `⚠️ Failed to save mapping for market ${market.handle}:`,
                mappingError.message,
              );
            }
          }

          // Sync currency settings after successful market creation
          if (market.currencySettings && result.market?.id) {
            log.push({
              timestamp: new Date().toISOString(),
              message: `💱 Syncing currency settings for new market: ${market.name}`,
              type: "currency_sync",
              details: {
                baseCurrency:
                  market.currencySettings.baseCurrency?.currencyCode,
                localCurrencies: market.currencySettings.localCurrencies,
                marketSupportsSettings: marketSupportsCurrencySettings(
                  market.conditions,
                ),
              },
            });

            const currencyResult = await syncMarketCurrencySettings(
              result.market.id,
              market.currencySettings,
              market.conditions,
              stagingAdmin,
            );

            if (currencyResult.success) {
              if (currencyResult.skipped) {
                log.push({
                  timestamp: new Date().toISOString(),
                  message: `⚠️ Currency settings skipped for new market "${market.name}": ${currencyResult.message}`,
                  type: "currency_sync",
                  skipped: true,
                  details: { reason: currencyResult.message },
                });
              } else {
                log.push({
                  timestamp: new Date().toISOString(),
                  message: `✅ Successfully synced currency settings for new market: ${market.name}`,
                  type: "currency_sync",
                  success: true,
                  details: {
                    baseCurrency:
                      market.currencySettings.baseCurrency?.currencyCode,
                    localCurrencies: market.currencySettings.localCurrencies,
                  },
                });
              }
            } else {
              summary.errors.push(
                `Currency sync failed for new "${market.name}": ${currencyResult.error}`,
              );
              log.push({
                timestamp: new Date().toISOString(),
                message: `❌ Currency sync failed for new market "${market.name}": ${currencyResult.error}`,
                type: "currency_sync",
                success: false,
                error: currencyResult.error,
              });
            }
          }

          // Sync web presences after successful market creation
          if (market.webPresences?.nodes?.length > 0 && result.market?.id) {
            const webPresenceDetails = market.webPresences.nodes.map((wp) => ({
              subfolderSuffix: wp.subfolderSuffix,
              defaultLocale: wp.defaultLocale?.locale,
              alternateLocales: wp.alternateLocales?.map((l) => l.locale) || [],
              domain: wp.domain?.host,
            }));

            log.push({
              timestamp: new Date().toISOString(),
              message: `🌐 Syncing web presences and locales for new market: ${market.name}`,
              type: "web_presence_sync",
              details: {
                count: market.webPresences.nodes.length,
                webPresences: webPresenceDetails,
              },
            });

            const webPresenceResult = await syncMarketWebPresences(
              result.market.id,
              market.webPresences.nodes,
              stagingAdmin,
            );

            if (webPresenceResult.success) {
              log.push({
                timestamp: new Date().toISOString(),
                message: `✅ Successfully synced ${webPresenceResult.created + webPresenceResult.updated} web presences for new market: ${market.name}`,
                type: "web_presence_sync",
                success: true,
                details: {
                  created: webPresenceResult.created,
                  updated: webPresenceResult.updated,
                  failed: webPresenceResult.failed,
                  total: webPresenceResult.created + webPresenceResult.updated,
                },
              });
            } else {
              summary.errors.push(
                `Web presence sync failed for new "${market.name}": ${webPresenceResult.error || webPresenceResult.errors?.join(", ")}`,
              );
              log.push({
                timestamp: new Date().toISOString(),
                message: `❌ Web presence sync failed for new market "${market.name}"`,
                type: "web_presence_sync",
                success: false,
                error:
                  webPresenceResult.error ||
                  webPresenceResult.errors?.join(", "),
                details: {
                  errors: webPresenceResult.errors || [],
                },
              });
            }
          }

          // Sync metafields after successful market creation
          if (market.metafields?.nodes?.length > 0 && result.market?.id) {
            const metafieldDetails = market.metafields.nodes.map((mf) => ({
              namespace: mf.namespace,
              key: mf.key,
              type: mf.type,
              valuePreview:
                mf.value?.length > 50
                  ? mf.value.substring(0, 50) + "..."
                  : mf.value,
            }));

            log.push({
              timestamp: new Date().toISOString(),
              message: `🏷️ Syncing metafields for new market: ${market.name}`,
              type: "metafields_sync",
              details: {
                count: market.metafields.nodes.length,
                metafields: metafieldDetails,
              },
            });

            const metafieldsResult = await syncMetafieldValues(
              result.market.id,
              "MARKET",
              market.metafields.nodes,
              stagingAdmin,
            );

            if (metafieldsResult.success) {
              log.push({
                timestamp: new Date().toISOString(),
                message: `✅ Successfully synced ${metafieldsResult.created + metafieldsResult.updated} metafields for new market: ${market.name}`,
                type: "metafields_sync",
                success: true,
                details: {
                  created: metafieldsResult.created,
                  updated: metafieldsResult.updated,
                  skipped: metafieldsResult.skipped,
                  failed: metafieldsResult.failed,
                  total: metafieldsResult.created + metafieldsResult.updated,
                  errors: metafieldsResult.errors || [],
                },
              });
            } else {
              summary.errors.push(
                `Metafields sync failed for new "${market.name}": ${metafieldsResult.error || metafieldsResult.errors?.join(", ")}`,
              );
              log.push({
                timestamp: new Date().toISOString(),
                message: `❌ Metafields sync failed for new market "${market.name}"`,
                type: "metafields_sync",
                success: false,
                error:
                  metafieldsResult.error || metafieldsResult.errors?.join(", "),
                details: {
                  errors: metafieldsResult.errors || [],
                },
              });
            }
          }

          // Unified Markets: curated catalog for newly created market
          try {
            const featuresQuery = `query { shop { features { unifiedMarkets } } }`;
            const featResp = await stagingAdmin.graphql(featuresQuery);
            const featJson = await featResp.json();
            const isUnified = !!featJson.data?.shop?.features?.unifiedMarkets;
            console.log(`[MARKETS DEBUG] unifiedMarkets: ${isUnified}`);
            if (isUnified) {
              const prodCat = await getProductionMarketCatalog(
                productionStore,
                accessToken,
                market.id,
              );
              if (prodCat) {
                console.log(
                  `[MARKETS DEBUG] Production catalog for ${market.name}:`,
                  {
                    title: prodCat.title,
                    currency: prodCat.currency,
                    products: prodCat.productHandles.length,
                  },
                );
                const ensureRes =
                  await ensureStagingCatalogWithCuratedPublication(
                    stagingAdmin,
                    result.market.id,
                    market.name,
                    prodCat.currency,
                    prodCat.productHandles,
                  );
                if (!ensureRes.success) {
                  console.warn(
                    `[MARKETS DEBUG] Failed to ensure curated catalog for ${market.name}:`,
                    ensureRes.error,
                  );
                } else {
                  console.log(
                    `[MARKETS DEBUG] Curated catalog created for ${market.name}:`,
                    ensureRes,
                  );
                }
              } else {
                console.log(
                  `[MARKETS DEBUG] No production catalog found for ${market.name}; skipping curated publication sync`,
                );
              }
            }
          } catch (e) {
            console.warn(
              `[MARKETS DEBUG] Catalog sync error for ${market.name}:`,
              e.message,
            );
          }
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

    // Step 4: Finalize
    onProgress({
      stage: "completed",
      message: "Market sync completed",
      percentage: 100,
    });

    // Calculate detailed statistics from logs
    const metafieldDefinitionsLogs = log.filter(
      (l) => l.type === "metafield_definitions_sync",
    );
    const currencyLogs = log.filter((l) => l.type === "currency_sync");
    const webPresenceLogs = log.filter((l) => l.type === "web_presence_sync");
    const metafieldLogs = log.filter((l) => l.type === "metafields_sync");

    const currencyStats = {
      successful: currencyLogs.filter((l) => l.success === true).length,
      skipped: currencyLogs.filter((l) => l.skipped === true).length,
      failed: currencyLogs.filter((l) => l.success === false).length,
    };

    const webPresenceStats = {
      successful: webPresenceLogs.filter((l) => l.success === true).length,
      failed: webPresenceLogs.filter((l) => l.success === false).length,
      totalCreated: webPresenceLogs.reduce(
        (sum, l) => sum + (l.details?.created || 0),
        0,
      ),
      totalUpdated: webPresenceLogs.reduce(
        (sum, l) => sum + (l.details?.updated || 0),
        0,
      ),
    };

    const metafieldStats = {
      successful: metafieldLogs.filter((l) => l.success === true).length,
      failed: metafieldLogs.filter((l) => l.success === false).length,
      totalCreated: metafieldLogs.reduce(
        (sum, l) => sum + (l.details?.created || 0),
        0,
      ),
      totalUpdated: metafieldLogs.reduce(
        (sum, l) => sum + (l.details?.updated || 0),
        0,
      ),
      totalSkipped: metafieldLogs.reduce(
        (sum, l) => sum + (l.details?.skipped || 0),
        0,
      ),
    };

    log.push({
      timestamp: new Date().toISOString(),
      message: `🎉 Market sync completed successfully!`,
      type: "sync_summary",
      success: true,
      details: {
        metafieldDefinitionsSync: {
          processed: metafieldDefinitionsLogs.length > 0,
          successful:
            metafieldDefinitionsLogs.filter((l) => l.success === true).length >
            0,
          created: metafieldDefinitionsLogs.reduce(
            (sum, l) => sum + (l.details?.created || 0),
            0,
          ),
          existing: metafieldDefinitionsLogs.reduce(
            (sum, l) => sum + (l.details?.existing || 0),
            0,
          ),
          skipped: metafieldDefinitionsLogs.reduce(
            (sum, l) => sum + (l.details?.skipped || 0),
            0,
          ),
          failed: metafieldDefinitionsLogs.reduce(
            (sum, l) => sum + (l.details?.failed || 0),
            0,
          ),
        },
        markets: {
          total: summary.total,
          created: summary.created,
          updated: summary.updated,
          failed: summary.failed,
          skipped: summary.skipped,
        },
        currencySync: {
          processed: currencyStats.successful + currencyStats.failed,
          successful: currencyStats.successful,
          skipped: currencyStats.skipped,
          failed: currencyStats.failed,
        },
        webPresenceSync: {
          marketsProcessed:
            webPresenceStats.successful + webPresenceStats.failed,
          successful: webPresenceStats.successful,
          failed: webPresenceStats.failed,
          webPresencesCreated: webPresenceStats.totalCreated,
          webPresencesUpdated: webPresenceStats.totalUpdated,
        },
        metafieldsSync: {
          marketsProcessed: metafieldStats.successful + metafieldStats.failed,
          successful: metafieldStats.successful,
          failed: metafieldStats.failed,
          metafieldsCreated: metafieldStats.totalCreated,
          metafieldsUpdated: metafieldStats.totalUpdated,
          metafieldsSkipped: metafieldStats.totalSkipped,
        },
        totalErrors: summary.errors.length,
        duration: `${((Date.now() - (Date.parse(log[0]?.timestamp) || Date.now())) / 1000).toFixed(1)}s`,
      },
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
