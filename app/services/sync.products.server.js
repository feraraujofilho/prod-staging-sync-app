/**
 * Enhanced Product sync service for Shopify stores
 * Syncs products, variants, inventory, and related metafields from production to staging using GraphQL Admin API
 * Matches Shopify Bulk Data Management capabilities
 */

import {
  syncMetafieldValues,
  syncMetafieldDefinitions,
} from "./sync.metafields.server.js";
import { getInventoryLevels } from "./sync.locations.helper.server.js";
import { saveMapping, extractIdFromGid } from "./resource-mapping.server.js";

/**
 * Retry utility for handling transient failures
 * @param {Function} operation - The operation to retry
 * @param {number} maxRetries - Maximum number of retry attempts
 * @param {number} delay - Delay between retries in milliseconds
 * @returns {Promise<any>} Result of the operation
 */
async function retryOperation(operation, maxRetries = 3, delay = 1000) {
  let lastError;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      console.warn(
        `Operation failed (attempt ${attempt}/${maxRetries}):`,
        error.message,
      );

      if (attempt < maxRetries) {
        const backoffDelay = delay * Math.pow(2, attempt - 1); // Exponential backoff
        console.log(`Retrying in ${backoffDelay}ms...`);
        await new Promise((resolve) => setTimeout(resolve, backoffDelay));
      }
    }
  }

  throw lastError;
}

/**
 * Fetch all available publications (sales channels) in the staging store.
 * Caches the result per sync run to avoid repeated API calls.
 */
let _cachedPublications = null;
async function getAllStagingPublications(stagingAdmin) {
  if (_cachedPublications) return _cachedPublications;

  const query = `
    query GetPublications($first: Int!) {
      publications(first: $first) { nodes { id name } }
    }
  `;
  try {
    const response = await stagingAdmin.graphql(query, {
      variables: { first: 50 },
    });
    const result = await response.json();
    const nodes = result.data?.publications?.nodes || [];
    console.log(
      `[PUBLISH] Found ${nodes.length} publications: ${nodes.map((p) => p.name).join(", ")}`,
    );
    _cachedPublications = nodes;
    return nodes;
  } catch (e) {
    console.warn("[PUBLISH] Failed to fetch publications:", e.message);
    return [];
  }
}

/**
 * Reset the publications cache (call at the start of each sync run).
 */
function resetPublicationsCache() {
  _cachedPublications = null;
}

/**
 * Publish a product to ALL available sales channels in the staging store.
 * Uses a single publishablePublish mutation with all publication IDs.
 * Requires write_publications scope and product status ACTIVE for storefront visibility.
 */
async function publishProductToAllChannels(productId, stagingAdmin) {
  const publications = await getAllStagingPublications(stagingAdmin);
  if (publications.length === 0) {
    return { success: false, error: "No publications found in staging store" };
  }

  const mutation = `
    mutation PublishToAll($id: ID!, $input: [PublicationInput!]!) {
      publishablePublish(id: $id, input: $input) {
        publishable {
          ... on Product {
            id
          }
        }
        userErrors { field message }
      }
    }
  `;

  const input = publications.map((pub) => ({ publicationId: pub.id }));

  try {
    const response = await stagingAdmin.graphql(mutation, {
      variables: { id: productId, input },
    });
    const result = await response.json();

    if (result.errors) {
      const msg = result.errors.map((e) => e.message).join(", ");
      console.warn(`[PUBLISH] Errors for ${productId}: ${msg}`);
      return { success: false, error: msg };
    }

    const errs = result.data?.publishablePublish?.userErrors || [];
    if (errs.length > 0) {
      const msg = errs.map((e) => e.message).join(", ");
      console.warn(`[PUBLISH] userErrors for ${productId}: ${msg}`);
      return { success: false, error: msg };
    }

    console.log(
      `📣 Published product ${productId} to ${publications.length} channels`,
    );
    return { success: true, channelCount: publications.length };
  } catch (e) {
    console.warn(
      `[PUBLISH] Failed to publish product ${productId}:`,
      e.message,
    );
    return { success: false, error: e.message };
  }
}

/**
 * Get all products from production store
 * @param {string} productionStore - The production store domain
 * @param {string} accessToken - The production store access token
 * @param {number} first - Number of products to fetch per page (reduced to avoid query cost limits)
 * @returns {Promise<Array>} Array of product objects
 *
 * NOTE: Query cost limits require small batch sizes due to complex nested data.
 * For large catalogs, consider implementing Shopify Bulk Operations API:
 * https://shopify.dev/docs/api/usage/bulk-operations/queries
 */
async function getProductionProducts(productionStore, accessToken, first = 5) {
  console.log("Fetching products from production:", {
    store: productionStore,
    hasToken: !!accessToken,
    tokenLength: accessToken?.length || 0,
    batchSize: first,
    note: "Using small batch size to avoid query cost limits",
  });

  const query = `
    query GetProducts($first: Int!, $after: String) {
      products(first: $first, after: $after) {
        edges {
          node {
            id
            handle
            title
            description
            descriptionHtml
            productType
            category {
              id
              name
              fullName
            }
            status
            tags
            vendor
            seo {
              title
              description
            }
            options {
              id
              name
              values
            }
            variants(first: 50) {
              pageInfo {
                hasNextPage
                endCursor
              }
              edges {
                node {
                  id
                  title
                  sku
                  barcode
                  price
                  compareAtPrice
                  taxable
                  inventoryPolicy
                  inventoryItem {
                    id
                    sku
                    tracked
                    requiresShipping
                    unitCost {
                      amount
                      currencyCode
                    }
                    countryCodeOfOrigin
                    provinceCodeOfOrigin
                    harmonizedSystemCode
                    countryHarmonizedSystemCodes(first: 5) {
                      edges {
                        node {
                          harmonizedSystemCode
                          countryCode
                        }
                      }
                    }
                    measurement {
                      id
                      weight {
                        value
                        unit
                      }
                    }
                  }
                  selectedOptions {
                    name
                    value
                  }
                  media(first: 5) {
                    edges {
                      node {
                        id
                        alt
                        mediaContentType
                        preview {
                          image {
                            url
                          }
                        }
                      }
                    }
                  }
                  metafields(first: 20) {
                    nodes {
                      id
                      namespace
                      key
                      value
                      type
                      definition {
                        description
                      }
                    }
                  }
                }
              }
            }
            media(first: 10) {
              edges {
                node {
                  ... on MediaImage {
                    id
                    image { url }
                  }
                }
              }
            }
            metafields(first: 20) {
              nodes {
                id
                namespace
                key
                value
                type
                definition {
                        description
                      }
              }
            }
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

  const allProducts = [];
  let hasNextPage = true;
  let after = null;
  let batchNumber = 1;

  try {
    while (hasNextPage) {
      console.log(`📦 Fetching product batch ${batchNumber}...`);
      const response = await retryOperation(
        async () => {
          return fetch(
            `https://${productionStore}/admin/api/2025-07/graphql.json`,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "X-Shopify-Access-Token": accessToken,
              },
              body: JSON.stringify({
                query,
                variables: { first, after },
              }),
            },
          );
        },
        3,
        2000,
      );

      const data = await response.json();

      // Debug: Log the raw response structure
      if (allProducts.length === 0 && hasNextPage) {
        console.log("First API response structure:", {
          hasData: !!data.data,
          hasProducts: !!data.data?.products,
          hasEdges: !!data.data?.products?.edges,
          edgesLength: data.data?.products?.edges?.length || 0,
          firstProductStructure: data.data?.products?.edges?.[0]
            ? {
                hasNode: !!data.data.products.edges[0].node,
                nodeKeys: Object.keys(data.data.products.edges[0].node || {}),
                imagesStructure: data.data.products.edges[0].node?.media,
              }
            : "No products",
        });
      }

      if (data.errors) {
        const errorMessage = Array.isArray(data.errors)
          ? data.errors.map((e) => e.message || e).join(", ")
          : typeof data.errors === "string"
            ? data.errors
            : JSON.stringify(data.errors);
        throw new Error(`GraphQL errors: ${errorMessage}`);
      }

      const products = data.data.products.edges.map((edge) => edge.node);

      // Check for products with more variants than we fetched
      products.forEach((product) => {
        if (product.variants?.pageInfo?.hasNextPage) {
          console.warn(
            `⚠️ Product "${product.title}" has more than 50 variants. Only first 50 will be synced.`,
          );
          console.warn(
            `   Consider implementing variant pagination or using Bulk Operations API for this product.`,
          );
        }
      });

      // Debug: Check first product for images
      if (products.length > 0) {
        console.log(`First product from production:`, {
          title: products[0].title,
          hasImages: !!products[0].media,
          imageEdges: products[0].media?.edges?.length || 0,
          firstImage: products[0].media?.edges?.[0]?.node || "No images",
          variantCount: products[0].variants?.edges?.length || 0,
          hasMoreVariants: products[0].variants?.pageInfo?.hasNextPage || false,
        });
      }

      allProducts.push(...products);
      console.log(
        `   ✅ Batch ${batchNumber}: ${products.length} products fetched (Total: ${allProducts.length})`,
      );

      hasNextPage = data.data.products.pageInfo.hasNextPage;
      after = data.data.products.pageInfo.endCursor;
      batchNumber++;

      // Add a small delay to avoid rate limiting and allow garbage collection
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Force garbage collection periodically to prevent memory buildup
      if (batchNumber % 10 === 0 && global.gc) {
        global.gc();
        console.log(`🧹 Forced garbage collection after batch ${batchNumber}`);
      }
    }

    console.log(
      `\n✨ Successfully fetched all ${allProducts.length} products from production in ${batchNumber - 1} batches`,
    );
    return allProducts;
  } catch (error) {
    console.error("Error fetching products from production:", error);
    throw error;
  }
}

/**
 * Check if a product exists in staging by handle
 * @param {string} handle - The product handle
 * @param {Object} stagingAdmin - Shopify admin API client for staging
 * @returns {Promise<Object|null>} Product object if exists, null otherwise
 */
async function getStagingProductByHandle(handle, stagingAdmin) {
  const query = `
    query GetProductByHandle($handle: String!, $variantsAfter: String) {
      product: productByIdentifier (identifier: { handle: $handle }){
        id
        handle
        title
        status
        variants(first: 100, after: $variantsAfter) {
          edges {
            node {
              id
              sku
              title
              inventoryItem {
                id
                tracked
              }
              selectedOptions {
                name
                value
              }
            }
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }
    }
  `;

  try {
    const variables = { handle, variantsAfter: null };
    const response = await stagingAdmin.graphql(query, { variables });
    const result = await response.json();

    if (result.errors) {
      console.error("Error getting staging product:", result.errors);
      return null;
    }

    const product = result.data?.product;
    if (!product) return null;

    // Paginate through remaining variants if needed
    let hasNextPage = product.variants?.pageInfo?.hasNextPage || false;
    let cursor = product.variants?.pageInfo?.endCursor || null;
    const allVariantEdges = [...(product.variants?.edges || [])];

    while (hasNextPage) {
      const nextResp = await stagingAdmin.graphql(query, {
        variables: { handle, variantsAfter: cursor },
      });
      const nextResult = await nextResp.json();
      const nextProduct = nextResult.data?.product;
      if (!nextProduct) break;

      const edges = nextProduct.variants?.edges || [];
      allVariantEdges.push(...edges);

      hasNextPage = nextProduct.variants?.pageInfo?.hasNextPage || false;
      cursor = nextProduct.variants?.pageInfo?.endCursor || null;
    }

    // Return product with all variants
    return {
      ...product,
      variants: { edges: allVariantEdges },
    };
  } catch (error) {
    console.error("Error getting staging product by handle:", error);
    return null;
  }
}

/**
 * Update variants for a product in staging using bulk operations
 * Enhanced to include inventory items and all variant fields
 * @param {string} productId - The product ID in staging
 * @param {Array} productionVariants - Array of variant objects from production
 * @param {Array} stagingVariants - Array of existing variant objects from staging
 * @param {Object} stagingAdmin - Shopify admin API client for staging
 * @returns {Promise<Object>} Result object with success status and variant data
 */
async function updateProductVariantsInStaging(
  productId,
  productionVariants,
  stagingVariants,
  stagingAdmin,
) {
  const mutation = `
    mutation productVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!, $allowPartialUpdates: Boolean) {
      productVariantsBulkUpdate(productId: $productId, variants: $variants, allowPartialUpdates: $allowPartialUpdates) {
        productVariants {
          id
          title
          sku
          barcode
          price
          compareAtPrice
          inventoryQuantity
          position
          inventoryItem {
            id
            sku
            tracked
            measurement {
              weight {
                value
                unit
              }
            }
          }
          selectedOptions {
            name
            value
          }
        }
        userErrors {
          field
          message

        }
      }
    }
  `;

  try {
    // Match production variants to staging variants by option values
    const variantUpdates = [];
    const variantsToCreate = [];
    const toKey = (v) =>
      v.selectedOptions
        .map((o) => `${o.name}:${o.value}`)
        .sort()
        .join("|");

    for (const prodVariant of productionVariants) {
      console.log(`\nMatching production variant: ${prodVariant.title}`);
      console.log(
        `  Production options: ${prodVariant.selectedOptions.map((o) => `${o.name}:${o.value}`).join(", ")}`,
      );

      // Find matching staging variant by option values
      const stagingVariant = stagingVariants.find((sv) => {
        // Make sure staging variant has selectedOptions
        if (!sv.selectedOptions || sv.selectedOptions.length === 0) {
          console.log(`  Staging variant ${sv.id} has no selectedOptions`);
          return false;
        }

        // Check if all selected options match
        const matches = prodVariant.selectedOptions.every((prodOption) => {
          const stagingOption = sv.selectedOptions.find(
            (so) => so.name === prodOption.name,
          );
          const match =
            stagingOption && stagingOption.value === prodOption.value;
          if (!match) {
            console.log(
              `  Option mismatch: ${prodOption.name}:${prodOption.value} not found in staging`,
            );
          }
          return match;
        });

        if (matches) {
          console.log(
            `  ✅ Found match: staging variant ${sv.id} (${sv.title})`,
          );
        }

        return matches;
      });

      if (stagingVariant) {
        const variantUpdate = {
          id: stagingVariant.id,
          barcode: prodVariant.barcode,
          price: prodVariant.price,
          compareAtPrice: prodVariant.compareAtPrice,
          inventoryPolicy: prodVariant.inventoryPolicy || "CONTINUE",
          taxable: prodVariant.taxable,
        };

        // Add inventory item data if present
        if (prodVariant.inventoryItem) {
          variantUpdate.inventoryItem = {
            tracked: prodVariant.inventoryItem.tracked,
            requiresShipping: prodVariant.inventoryItem.requiresShipping,
          };

          // Add weight if present in measurement
          if (prodVariant.inventoryItem?.measurement?.weight) {
            variantUpdate.inventoryItem.measurement = {
              weight: {
                value: prodVariant.inventoryItem.measurement.weight.value,
                unit: prodVariant.inventoryItem.measurement.weight.unit,
              },
            };
          }

          // Set SKU on inventory item (belongs here in the new product model)
          if (prodVariant.sku || prodVariant.inventoryItem?.sku) {
            variantUpdate.inventoryItem.sku =
              prodVariant.sku || prodVariant.inventoryItem.sku;
          }

          // Add cost if present (now unitCost)
          if (prodVariant.inventoryItem?.unitCost) {
            variantUpdate.inventoryItem.cost =
              prodVariant.inventoryItem.unitCost.amount;
          }

          // Add country codes if present
          if (prodVariant.inventoryItem?.countryCodeOfOrigin) {
            variantUpdate.inventoryItem.countryCodeOfOrigin =
              prodVariant.inventoryItem.countryCodeOfOrigin;
          }

          // Add harmonized system code
          if (prodVariant.inventoryItem?.harmonizedSystemCode) {
            variantUpdate.inventoryItem.harmonizedSystemCode =
              prodVariant.inventoryItem.harmonizedSystemCode;
          }

          // Add country harmonized system codes if present
          if (
            prodVariant.inventoryItem?.countryHarmonizedSystemCodes?.edges
              ?.length > 0
          ) {
            variantUpdate.inventoryItem.countryHarmonizedSystemCodes =
              prodVariant.inventoryItem.countryHarmonizedSystemCodes.edges.map(
                (edge) => ({
                  countryCode: edge.node.countryCode,
                  harmonizedSystemCode: edge.node.harmonizedSystemCode,
                }),
              );
          }
        }

        variantUpdates.push(variantUpdate);
      } else {
        variantsToCreate.push(prodVariant);
        console.warn(
          `  ❌ No matching staging variant found for: ${prodVariant.title}`,
        );
      }
    }

    if (variantsToCreate.length > 0) {
      console.log(
        `Creating ${variantsToCreate.length} variants with bulk operation`,
      );
      const createRes = await createProductVariantsInStaging(
        productId,
        variantsToCreate,
        stagingAdmin,
      );
      if (!createRes.success)
        throw new Error(
          `Failed to create missing variants: ${createRes.error}`,
        );
      else {
        console.log(`✅ Created ${createRes.variants.length} variants`);
      }
      const allStaging = [...stagingVariants, ...createRes.variants];

      const stagingMap = new Map(allStaging.map((v) => [toKey(v), v]));
      for (const prodVariant of variantsToCreate) {
        const match = stagingMap.get(toKey(prodVariant));
        if (!match) continue;
        variantUpdates.push({
          id: match.id,
          sku: prodVariant.sku,
          barcode: prodVariant.barcode,
          price: prodVariant.price,
          compareAtPrice: prodVariant.compareAtPrice,
          inventoryPolicy: prodVariant.inventoryPolicy || "CONTINUE",
          taxable: prodVariant.taxable,
          // inventoryItem: {...} // include guarded inventory fields as you already do
        });
      }

      // Update stagingVariants reference if you use it later in this function
      stagingVariants = allStaging;
    }

    if (variantUpdates.length === 0) {
      console.warn(
        "No variants to update - no matches found between production and staging",
      );
      return {
        success: false,
        error: "No matching variants found to update",
      };
    }

    console.log(
      `Updating ${variantUpdates.length} variants with bulk operation`,
    );

    const variables = {
      productId,
      variants: variantUpdates,
      allowPartialUpdates: true, // Continue on error for individual variants
    };

    const response = await stagingAdmin.graphql(mutation, { variables });
    const result = await response.json();

    if (result.errors) {
      const errors = result.errors.map((e) => e.message).join(", ");
      throw new Error(`GraphQL errors: ${errors}`);
    }

    if (result.data?.productVariantsBulkUpdate?.userErrors?.length > 0) {
      const errors = result.data.productVariantsBulkUpdate.userErrors
        .map((e) => `${e.field}: ${e.message}`)
        .join(", ");
      throw new Error(`Failed to update variants: ${errors}`);
    }

    if (result.data?.productVariantsBulkUpdate?.productVariants?.length) {
      const updated = result.data.productVariantsBulkUpdate.productVariants;
      console.log(`Updated ${updated.length} variant(s):`);
      updated.forEach((v) => {
        const options = (v.selectedOptions || [])
          .map((o) => `${o.name}:${o.value}`)
          .join(" | ");
        console.log(
          `  [VARIANT UPDATED] ${v.title} (id: ${v.id}${v.sku ? `, sku: ${v.sku}` : ""}) - ${options}`,
        );
      });
    }

    return {
      success: true,
      variants: result.data.productVariantsBulkUpdate.productVariants,
    };
  } catch (error) {
    console.error(`Error updating product variants:`, error);
    return {
      success: false,
      error: error.message || "Unknown error occurred",
    };
  }
}

/**
 * Sync inventory quantities for a variant across locations
 * @param {Object} prodVariant - Production variant with inventory item
 * @param {Object} stagingVariant - Staging variant with inventory item
 * @param {Map} locationMap - Map of production to staging location IDs
 * @param {Object} productionAdmin - Production store admin client
 * @param {Object} stagingAdmin - Staging store admin client
 * @returns {Promise<Object>} Result with success status and details
 */
async function syncVariantInventory(
  prodVariant,
  stagingVariant,
  locationMap,
  productionAdmin,
  stagingAdmin,
) {
  const results = {
    success: true,
    synced: [],
    failed: [],
    errors: [],
  };

  try {
    // Skip if no inventory item on either side
    if (!prodVariant.inventoryItem?.id || !stagingVariant.inventoryItem?.id) {
      console.log(
        `Skipping inventory sync - missing inventory item for variant ${prodVariant.sku}`,
      );
      return results;
    }

    // Get inventory levels from production
    const prodInventoryLevels = await getInventoryLevels(
      prodVariant.inventoryItem.id,
      productionAdmin,
    );

    if (prodInventoryLevels.length === 0) {
      console.log(`No inventory levels found for variant ${prodVariant.sku}`);
      return results;
    }

    // Sync inventory for each location
    for (const prodLevel of prodInventoryLevels) {
      const stagingLocationId = locationMap.get(prodLevel.location.id);

      if (!stagingLocationId) {
        console.warn(
          `No matching staging location for ${prodLevel.location.name}`,
        );
        results.failed.push({
          location: prodLevel.location.name,
          reason: "No matching staging location",
        });
        continue;
      }

      // Get the available quantity from production
      const availableQty =
        prodLevel.quantities?.find((q) => q.name === "available")?.quantity ||
        0;

      console.log(
        `Syncing inventory for ${prodVariant.sku || "[NO SKU]"} at ${prodLevel.location.name}:`,
      );
      console.log(
        `  Production quantity: ${availableQty} (from ${prodLevel.quantities?.length || 0} quantity states)`,
      );
      console.log(
        `  Production inventoryItem ID: ${prodVariant.inventoryItem.id}`,
      );
      console.log(
        `  Staging inventoryItem ID: ${stagingVariant.inventoryItem.id}`,
      );
      console.log(`  Staging location ID: ${stagingLocationId}`);

      // Check current quantity first to avoid unnecessary updates
      let shouldUpdate = true;
      try {
        const checkQuery = `
          query checkInventory($inventoryItemId: ID!, $locationId: ID!) {
            inventoryLevel(inventoryItemId: $inventoryItemId, locationId: $locationId) {
              quantities(names: "available") {
                name
                quantity
              }
            }
          }
        `;
        const checkResp = await stagingAdmin.graphql(checkQuery, {
          variables: {
            inventoryItemId: stagingVariant.inventoryItem.id,
            locationId: stagingLocationId,
          },
        });
        const checkResult = await checkResp.json();
        const currentQty =
          checkResult.data?.inventoryLevel?.quantities?.find(
            (q) => q.name === "available",
          )?.quantity ?? null;

        if (currentQty === availableQty) {
          console.log(
            `  ⏭️  Inventory already correct (${currentQty} units), skipping`,
          );
          results.synced.push({
            location: prodLevel.location.name,
            sku: prodVariant.sku || "[NO SKU]",
            quantity: currentQty,
          });
          shouldUpdate = false;
        } else {
          console.log(
            `  Current: ${currentQty ?? "not stocked"}, Target: ${availableQty}`,
          );
        }
      } catch (e) {
        // Item not stocked yet, proceed with activation
        console.log(`  Item not stocked at location yet, will activate`);
      }

      if (!shouldUpdate) {
        continue;
      }

      // Step 1: Ensure the item is activated at the location (without setting quantity)
      const activateMutation = `
        mutation inventoryActivate($inventoryItemId: ID!, $locationId: ID!) {
          inventoryActivate(inventoryItemId: $inventoryItemId, locationId: $locationId) {
            inventoryLevel {
              id
            }
            userErrors {
              field
              message
            }
          }
        }
      `;

      try {
        console.log(
          `  Ensuring inventory is activated at location...`,
        );
        const activateResult = await retryOperation(async () => {
          const resp = await stagingAdmin.graphql(activateMutation, {
            variables: {
              inventoryItemId: stagingVariant.inventoryItem.id,
              locationId: stagingLocationId,
            },
          });
          return await resp.json();
        });

        const activateErrors = activateResult.data?.inventoryActivate?.userErrors || [];
        // Ignore "already active" style errors — that's fine, we just need it active
        if (activateResult.errors) {
          console.warn(`  ⚠️ Activation GraphQL errors (proceeding anyway):`, activateResult.errors.map(e => e.message).join(", "));
        } else if (activateErrors.length > 0) {
          console.log(`  ℹ️ Activation note: ${activateErrors.map(e => e.message).join(", ")}`);
        } else {
          console.log(`  ✅ Inventory activated at location`);
        }

        // Step 2: Set the quantity using inventorySetQuantities (works for both new and existing stock)
        const setQuantitiesMutation = `
          mutation inventorySetQuantities($input: InventorySetQuantitiesInput!) {
            inventorySetQuantities(input: $input) {
              inventoryAdjustmentGroup {
                createdAt
                reason
              }
              userErrors {
                field
                message
              }
            }
          }
        `;

        console.log(
          `  Setting inventory quantity to ${availableQty}...`,
        );
        const setResult = await retryOperation(async () => {
          const resp = await stagingAdmin.graphql(setQuantitiesMutation, {
            variables: {
              input: {
                name: "available",
                reason: "correction",
                ignoreCompareQuantity: true,
                quantities: [
                  {
                    inventoryItemId: stagingVariant.inventoryItem.id,
                    locationId: stagingLocationId,
                    quantity: availableQty,
                  },
                ],
              },
            },
          });
          return await resp.json();
        });

        if (
          setResult.errors ||
          setResult.data?.inventorySetQuantities?.userErrors?.length > 0
        ) {
          const errors =
            setResult.errors || setResult.data.inventorySetQuantities.userErrors;
          console.error(
            `❌ Failed to set inventory for ${prodVariant.sku || "[NO SKU]"} at ${prodLevel.location.name}:`,
          );
          console.error(`  Errors:`, JSON.stringify(errors, null, 2));
          results.failed.push({
            location: prodLevel.location.name,
            sku: prodVariant.sku || "[NO SKU]",
            errors: errors.map((e) => e.message || e.code || JSON.stringify(e)),
          });
          results.success = false;
        } else {
          console.log(
            `✅ Set inventory for ${prodVariant.sku || "[NO SKU]"} at ${prodLevel.location.name}: ${availableQty} units`,
          );
          results.synced.push({
            location: prodLevel.location.name,
            sku: prodVariant.sku || "[NO SKU]",
            quantity: availableQty,
          });

          // Note: Only set "available" quantity. Setting "on_hand" separately
          // would inflate available on staging (which has no committed orders).
        }
      } catch (error) {
        console.error(`Error setting inventory for ${prodVariant.sku || "[NO SKU]"}:`, error);
        results.failed.push({
          location: prodLevel.location.name,
          sku: prodVariant.sku || "[NO SKU]",
          error: error.message,
        });
        results.success = false;
      }
    }

    return results;
  } catch (error) {
    console.error("Error syncing variant inventory:", error);
    results.success = false;
    results.errors.push(error.message);
    return results;
  }
}

/**
 * Create variants for a product in staging
 * @param {string} productId - The product ID in staging
 * @param {Array} variants - Array of variant objects from production
 * @param {Object} stagingAdmin - Shopify admin API client for staging
 * @returns {Promise<Object>} Result object with success status and variant data
 */
async function createProductVariantsInStaging(
  productId,
  variants,
  stagingAdmin,
) {
  const mutation = `
    mutation productVariantsBulkCreate($productId: ID!, $variants: [ProductVariantsBulkInput!]!, $strategy: ProductVariantsBulkCreateStrategy) {
      productVariantsBulkCreate(productId: $productId, variants: $variants, strategy: $strategy) {
        productVariants {
          id
          title
          sku
          barcode
          price
          compareAtPrice
          inventoryQuantity
          position
          inventoryItem {
            id
            sku
            tracked
            measurement {
              weight {
                value
                unit
              }
            }
          }
          selectedOptions {
            name
            value
          }
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  try {
    // Prepare variant inputs with all fields
    const variantInputs = variants.map((variant) => {
      const input = {
        barcode: variant.barcode,
        price: variant.price,
        compareAtPrice: variant.compareAtPrice,
        taxable: variant.taxable,
        inventoryPolicy: variant.inventoryPolicy || "CONTINUE",
        // position: variant.position, // REMOVED - not valid for ProductVariantsBulkInput
        optionValues: variant.selectedOptions.map((option) => ({
          optionName: option.name,
          name: option.value,
        })),
      };

      // Add inventory item data if present. In the new product model, SKU lives on InventoryItem.
      if (variant.inventoryItem || variant.sku) {
        input.inventoryItem = {
          tracked: variant.inventoryItem?.tracked || false,
          requiresShipping: variant.inventoryItem?.requiresShipping,
        };

        // Add SKU if present (variant.sku should be mapped here)
        if (variant.sku || variant.inventoryItem?.sku) {
          input.inventoryItem.sku = variant.sku || variant.inventoryItem.sku;
        }

        // Add weight if present in measurement
        if (variant.inventoryItem?.measurement?.weight) {
          input.inventoryItem.measurement = {
            weight: {
              value: variant.inventoryItem.measurement.weight.value,
              unit: variant.inventoryItem.measurement.weight.unit,
            },
          };
        }

        // Add cost if present (now unitCost)
        if (variant.inventoryItem?.unitCost) {
          input.inventoryItem.cost = variant.inventoryItem.unitCost.amount;
        }

        if (variant.inventoryItem?.countryCodeOfOrigin) {
          input.inventoryItem.countryCodeOfOrigin =
            variant.inventoryItem.countryCodeOfOrigin;
        }

        if (variant.inventoryItem?.harmonizedSystemCode) {
          input.inventoryItem.harmonizedSystemCode =
            variant.inventoryItem.harmonizedSystemCode;
        }

        // Add country harmonized system codes if present
        if (
          variant.inventoryItem?.countryHarmonizedSystemCodes?.edges?.length > 0
        ) {
          input.inventoryItem.countryHarmonizedSystemCodes =
            variant.inventoryItem.countryHarmonizedSystemCodes.edges.map(
              (edge) => ({
                countryCode: edge.node.countryCode,
                harmonizedSystemCode: edge.node.harmonizedSystemCode,
              }),
            );
        }
      }

      return input;
    });

    const variables = {
      productId,
      variants: variantInputs,
      strategy: "DEFAULT", // Use default strategy for variant creation
    };

    const response = await stagingAdmin.graphql(mutation, { variables });
    const result = await response.json();

    if (result.errors) {
      const errors = result.errors.map((e) => e.message).join(", ");
      throw new Error(`GraphQL errors: ${errors}`);
    }

    if (result.data?.productVariantsBulkCreate?.userErrors?.length > 0) {
      const errors = result.data.productVariantsBulkCreate.userErrors
        .map((e) => `${e.field}: ${e.message}`)
        .join(", ");
      throw new Error(`Failed to create variants: ${errors}`);
    }

    // Console log each created variant for visibility during sync runs
    const created = result.data.productVariantsBulkCreate.productVariants || [];
    if (created.length > 0) {
      console.log(`Created ${created.length} variant(s):`);
      created.forEach((v) => {
        const options = (v.selectedOptions || [])
          .map((o) => `${o.name}:${o.value}`)
          .join(" | ");
        console.log(
          `  [VARIANT CREATED] ${v.title} (id: ${v.id}${v.sku ? `, sku: ${v.sku}` : ""}) - ${options}`,
        );
      });
    }

    return {
      success: true,
      variants: result.data.productVariantsBulkCreate.productVariants,
    };
  } catch (error) {
    console.error(`Error creating product variants:`, error);
    return {
      success: false,
      error: error.message || "Unknown error occurred",
    };
  }
}

/**
 * Check if a product already has images in staging
 * @param {string} productId - The product ID in staging
 * @param {Object} stagingAdmin - Shopify admin API client for staging
 * @returns {Promise<number>} Number of existing images
 */
async function checkExistingImages(productId, stagingAdmin) {
  const query = `
    query GetProductImages($id: ID!) {
      product(id: $id) {
        media(first: 100) {
          edges {
            node {
              ... on MediaImage {
                id
                image { url }
              }
            }
          }
        }
      }
    }
  `;

  try {
    const response = await stagingAdmin.graphql(query, {
      variables: { id: productId },
    });
    const result = await response.json();

    if (result.data?.product?.media?.edges) {
      // Count only MediaImage nodes
      return result.data.product.media.edges.filter(
        (e) =>
          !!e.node &&
          e.node.__typename !== "Video" &&
          e.node.__typename !== "ExternalVideo" &&
          e.node.__typename !== "Model3d",
      ).length;
    }

    return 0;
  } catch (error) {
    console.error(`Error checking existing images:`, error);
    return 0;
  }
}

/**
 * Upload images for a product in staging
 * @param {string} productId - The product ID in staging
 * @param {Array} images - Array of image objects from production
 * @param {Object} stagingAdmin - Shopify admin API client for staging
 * @returns {Promise<Object>} Result object with success status and media data
 */
async function uploadProductImagesInStaging(productId, images, stagingAdmin) {
  const createMediaMutation = `
    mutation productCreateMedia($media: [CreateMediaInput!]!, $productId: ID!) {
      productCreateMedia(media: $media, productId: $productId) {
        media {
          ... on MediaImage {
            id
            image { url }
          }
        }
        mediaUserErrors { field message code }
      }
    }
  `;

  try {
    // Prepare media inputs from production image edges (url field already present in query)
    const mediaInputs = images.map((image) => ({
      originalSource: image.url,
      mediaContentType: "IMAGE",
      alt: image.alt || image.altText || "",
    }));

    console.log(`Preparing to upload ${mediaInputs.length} images`);
    console.log("Sample image URL:", mediaInputs[0]?.originalSource);

    const variables = {
      productId,
      media: mediaInputs,
    };

    const response = await stagingAdmin.graphql(createMediaMutation, {
      variables,
    });
    const result = await response.json();

    console.log("Image upload response:", JSON.stringify(result, null, 2));

    if (result.errors) {
      const errors = result.errors.map((e) => e.message).join(", ");
      throw new Error(`GraphQL errors: ${errors}`);
    }

    if (result.data?.productCreateMedia?.mediaUserErrors?.length > 0) {
      const errors = result.data.productCreateMedia.mediaUserErrors
        .map((e) => `${e.field}: ${e.message}`)
        .join(", ");
      throw new Error(`Failed to upload images: ${errors}`);
    }

    return {
      success: true,
      media: result.data.productCreateMedia.media,
    };
  } catch (error) {
    console.error(`Error uploading product images:`, error);
    return {
      success: false,
      error: error.message || "Unknown error occurred",
    };
  }
}

/**
 * Create a new product in staging
 * @param {Object} product - The product object from production
 * @param {Object} stagingAdmin - Shopify admin API client for staging
 * @returns {Promise<Object>} Result object with success status and product data
 */
async function createProductInStaging(product, stagingAdmin) {
  const mutation = `
    mutation productCreate($input: ProductInput!) {
      productCreate(input: $input) {
        product {
          id
          handle
          title
          status
          variants(first: 100) {
            edges {
              node {
                id
                title
                sku
                price
                inventoryItem {
                  id
                }
                selectedOptions {
                  name
                  value
                }
              }
            }
          }
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  try {
    // Prepare product input
    const input = {
      title: product.title,
      handle: product.handle,
      descriptionHtml: product.descriptionHtml || product.description,
      productType: product.productType,
      status: product.status,
      tags: product.tags,
      vendor: product.vendor,
    };

    // Add SEO if present
    if (product.seo) {
      input.seo = {
        title: product.seo.title,
        description: product.seo.description,
      };
    }

    // Set product category if present (uses new `category` field, not deprecated `productCategory`)
    if (product.category?.id) {
      input.category = product.category.id;
      console.log(
        `  Setting product category: ${product.category.fullName || product.category.name} (${product.category.id})`,
      );
    }

    // Add product options
    if (product.options && product.options.length > 0) {
      // Filter out the default "Title" option if it exists
      const filteredOptions = product.options.filter(
        (option) =>
          option.name !== "Title" ||
          option.values.length > 1 ||
          option.values[0] !== "Default Title",
      );

      if (filteredOptions.length > 0) {
        console.log(`Creating product with ${filteredOptions.length} options:`);
        filteredOptions.forEach((option) => {
          console.log(`  - ${option.name}: ${option.values.join(", ")}`);
        });

        input.productOptions = filteredOptions.map((option) => ({
          name: option.name,
          values: option.values.map((value) => ({ name: value })),
        }));
      }
    }

    // Note: variants and images are not part of ProductCreateInput
    // They need to be created separately after product creation

    const variables = { input };
    const response = await stagingAdmin.graphql(mutation, { variables });
    const result = await response.json();

    console.log(
      `Product creation result for "${product.title}":`,
      JSON.stringify(result, null, 2),
    );

    if (result.errors) {
      const errors = result.errors.map((e) => e.message).join(", ");
      throw new Error(`GraphQL errors: ${errors}`);
    }

    if (result.data?.productCreate?.userErrors?.length > 0) {
      const errors = result.data.productCreate.userErrors
        .map((e) => `${e.field}: ${e.message}`)
        .join(", ");
      throw new Error(
        `Failed to create product "${product.title}" (handle: ${product.handle}): ${errors}`,
      );
    }

    if (!result.data?.productCreate?.product) {
      throw new Error(
        `Failed to create product "${product.title}" (handle: ${product.handle}): No product returned from API`,
      );
    }

    const createdProduct = result.data.productCreate.product;

    // Create variants if they exist
    // IMPORTANT: productCreate with productOptions only creates the FIRST variant combination
    // We need to create all other variants manually using productVariantsBulkCreate
    if (product.variants?.edges?.length > 0) {
      const variants = product.variants.edges.map((edge) => edge.node);

      console.log(
        `Product "${product.title}" has ${variants.length} variants from production`,
      );
      variants.forEach((v, i) => {
        console.log(`  Variant ${i + 1}: ${v.title} (SKU: ${v.sku})`);
      });

      {
        // Get the staging variants that were auto-created (should be only 1)
        const stagingVariants =
          createdProduct.variants?.edges?.map((e) => e.node) || [];

        console.log(
          `Found ${stagingVariants.length} auto-created variant(s) in staging (expected ${variants.length})`,
        );

        // Shopify only creates the first variant when using productOptions
        // We need to create the remaining variants
        if (stagingVariants.length < variants.length) {
          console.log(
            `Need to create ${variants.length - stagingVariants.length} additional variants`,
          );

          // Create a set of existing variant combinations for comparison
          const existingCombinations = new Set(
            stagingVariants.map((v) =>
              v.selectedOptions
                .map((o) => `${o.name}:${o.value}`)
                .sort()
                .join("|"),
            ),
          );

          // Identify which production variants need to be created in staging
          const variantsToCreate = [];
          for (const variant of variants) {
            const combination = variant.selectedOptions
              .map((o) => `${o.name}:${o.value}`)
              .sort()
              .join("|");

            if (!existingCombinations.has(combination)) {
              variantsToCreate.push(variant);
            }
          }

          if (variantsToCreate.length > 0) {
            console.log(
              `Creating ${variantsToCreate.length} missing variants...`,
            );

            // Create the missing variants
            const createResult = await createProductVariantsInStaging(
              createdProduct.id,
              variantsToCreate,
              stagingAdmin,
            );

            if (createResult.success) {
              console.log(
                `✅ Successfully created ${createResult.variants?.length || 0} additional variants`,
              );

              // Combine all variants
              const allVariants = [
                ...stagingVariants,
                ...(createResult.variants || []),
              ];

              createdProduct.variants = {
                edges: allVariants.map((v) => ({ node: v })),
              };
            } else {
              console.error(
                `❌ Failed to create additional variants: ${createResult.error}`,
              );
            }
          }
        }

        // Now update all variants with production data (SKU, price, etc.)
        const allStagingVariants =
          createdProduct.variants?.edges?.map((e) => e.node) || [];
        if (allStagingVariants.length > 0) {
          console.log(
            `Updating ${allStagingVariants.length} variants with production data...`,
          );

          const variantsResult = await updateProductVariantsInStaging(
            createdProduct.id,
            variants,
            allStagingVariants,
            stagingAdmin,
          );

          if (variantsResult.success) {
            console.log(
              `✅ Successfully updated ${variantsResult.variants?.length || 0} variants`,
            );
            createdProduct.variants = {
              edges: variantsResult.variants.map((v) => ({ node: v })),
            };
          } else {
            console.error(
              `⚠️ Failed to update variant data: ${variantsResult.error}`,
            );
          }
        }
      }
    }

    // Upload images if they exist
    if (product.media?.edges?.length > 0) {
      const images = product.media.edges
        .map((edge) => edge.node)
        .filter((n) => n && n.image && n.image.url)
        .map((n) => ({ url: n.image.url }));
      console.log(
        `Uploading ${images.length} images for product "${product.title}"`,
      );

      const imagesResult = await uploadProductImagesInStaging(
        createdProduct.id,
        images,
        stagingAdmin,
      );

      if (!imagesResult.success) {
        console.error(
          `Failed to upload images for product "${product.title}": ${imagesResult.error}`,
        );
        // Continue with the process even if images fail
      } else {
        console.log(
          `Successfully uploaded ${imagesResult.media?.length || 0} images for product "${product.title}"`,
        );
      }
    }

    return {
      success: true,
      product: createdProduct,
    };
  } catch (error) {
    console.error(`Error creating product "${product.title}":`, error);
    return {
      success: false,
      error: error.message || "Unknown error occurred",
    };
  }
}

/**
 * Update an existing product in staging
 * @param {string} productId - The product ID in staging
 * @param {Object} product - The product object from production
 * @param {Object} stagingAdmin - Shopify admin API client for staging
 * @returns {Promise<Object>} Result object with success status and product data
 */
async function updateProductInStaging(productId, product, stagingAdmin) {
  const mutation = `
    mutation productUpdate($input: ProductInput!) {
      productUpdate(input: $input) {
        product {
          id
          handle
          title
          status
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  try {
    // Prepare product input for update
    const input = {
      id: productId,
      title: product.title,
      descriptionHtml: product.descriptionHtml || product.description,
      productType: product.productType,
      status: product.status,
      tags: product.tags,
      vendor: product.vendor,
    };

    // Add SEO if present
    if (product.seo) {
      input.seo = {
        title: product.seo.title,
        description: product.seo.description,
      };
    }

    // Set product category if present (uses new `category` field, not deprecated `productCategory`)
    if (product.category?.id) {
      input.category = product.category.id;
      console.log(
        `  Setting product category: ${product.category.fullName || product.category.name} (${product.category.id})`,
      );
    }

    const variables = { input };
    const response = await stagingAdmin.graphql(mutation, { variables });
    const result = await response.json();

    console.log(
      `Product update result for "${product.title}":`,
      JSON.stringify(result, null, 2),
    );

    if (result.errors) {
      const errors = result.errors.map((e) => e.message).join(", ");
      throw new Error(`GraphQL errors: ${errors}`);
    }

    if (result.data?.productUpdate?.userErrors?.length > 0) {
      const errors = result.data.productUpdate.userErrors
        .map((e) => `${e.field}: ${e.message}${e.code ? ` (${e.code})` : ""}`)
        .join(", ");
      throw new Error(
        `Failed to update product "${product.title}" (handle: ${product.handle}): ${errors}`,
      );
    }

    const updatedProduct = result.data.productUpdate.product;

    // Upload images if they exist and not already present
    if (product.media?.edges?.length > 0) {
      // Check if product already has images in staging
      const existingImageCount = await checkExistingImages(
        updatedProduct.id,
        stagingAdmin,
      );

      if (existingImageCount === 0) {
        const images = product.media.edges
          .map((edge) => edge.node)
          .filter((n) => n && n.image && n.image.url)
          .map((n) => ({ url: n.image.url }));
        console.log(
          `Uploading ${images.length} images for updated product "${product.title}"`,
        );

        const imagesResult = await uploadProductImagesInStaging(
          updatedProduct.id,
          images,
          stagingAdmin,
        );

        if (!imagesResult.success) {
          console.error(
            `Failed to upload images for product "${product.title}": ${imagesResult.error}`,
          );
          // Continue with the process even if images fail
        } else {
          console.log(
            `Successfully uploaded ${imagesResult.media?.length || 0} images for product "${product.title}"`,
          );
        }
      } else {
        console.log(
          `Product "${product.title}" already has ${existingImageCount} images in staging, skipping image upload`,
        );
      }
    }

    return {
      success: true,
      product: updatedProduct,
    };
  } catch (error) {
    console.error(`Error updating product "${product.title}":`, error);
    return {
      success: false,
      error: error.message || "Unknown error occurred",
    };
  }
}

/**
 * Sync products from production to staging
 * @param {string} productionStore - The production store domain
 * @param {string} accessToken - The production store access token
 * @param {Object} stagingAdmin - Shopify admin API client for staging
 * @param {Function} onProgress - Progress callback function
 * @returns {Promise<Object>} Sync summary
 */
export async function syncProducts(
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
    inventory: {
      synced: 0,
      failed: 0,
    },
  };
  let locationMap = new Map();

  // Reset publications cache for each sync run
  resetPublicationsCache();

  // Create production admin client for API calls
  const productionAdmin = {
    graphql: async (query, options) => {
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
            variables: options?.variables,
          }),
        },
      );
      return response;
    },
  };

  try {
    // Add initial summary log
    log.push({
      timestamp: new Date().toISOString(),
      message: "🚀 Starting enhanced products sync operation",
      type: "sync_start",
      details: {
        productionStore,
        timestamp: new Date().toISOString(),
        operation: "products_sync",
        features: ["products", "variants", "inventory", "metafields", "images"],
      },
    });

    // Step 0: Load location mappings from database (created during location sync)
    log.push({
      timestamp: new Date().toISOString(),
      message: "📍 Loading location mappings from database...",
      type: "location_mapping",
    });

    onProgress({
      stage: "locations",
      message: "Loading location mappings...",
      percentage: 2,
    });

    try {
      if (storeConnectionId) {
        // Import getMappings function
        const { getMappings } = await import("./resource-mapping.server.js");

        // Get location mappings from database
        const locationMappings = await getMappings(
          storeConnectionId,
          "location",
        );

        // Build map: production GID -> staging GID
        locationMap = new Map(
          locationMappings.map((m) => [m.productionGid, m.stagingGid]),
        );

        log.push({
          timestamp: new Date().toISOString(),
          message: `✅ Loaded ${locationMap.size} location mappings from database`,
          type: "location_mapping",
          success: true,
          details: {
            mappingsLoaded: locationMap.size,
          },
        });
      } else {
        log.push({
          timestamp: new Date().toISOString(),
          message: `⚠️ No storeConnectionId provided. Skipping location mapping.`,
          type: "location_mapping",
          success: false,
        });
      }
    } catch (error) {
      log.push({
        timestamp: new Date().toISOString(),
        message: `⚠️ Failed to load location mappings: ${error.message}. Continuing without inventory sync.`,
        type: "location_mapping",
        success: false,
        error: error.message,
      });
    }

    // Step 1: Sync metafield definitions for PRODUCT and PRODUCTVARIANT owner types
    log.push({
      timestamp: new Date().toISOString(),
      message:
        "🔧 Syncing product metafield definitions before processing products...",
      type: "metafield_definitions_sync",
    });

    onProgress({
      stage: "metafield_definitions",
      message: "Syncing product metafield definitions...",
      percentage: 5,
    });

    try {
      const metafieldDefinitionsResult = await syncMetafieldDefinitions(
        productionStore,
        accessToken,
        stagingAdmin,
        ["PRODUCT", "PRODUCTVARIANT"], // Sync both product and variant metafield definitions
      );

      if (metafieldDefinitionsResult.success) {
        log.push({
          timestamp: new Date().toISOString(),
          message: `✅ Successfully synced product metafield definitions`,
          type: "metafield_definitions_sync",
          success: true,
          details: metafieldDefinitionsResult.summary,
        });
      } else {
        log.push({
          timestamp: new Date().toISOString(),
          message: `⚠️ Product metafield definitions sync had issues: ${metafieldDefinitionsResult.error || "Unknown error"}`,
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

    // Step 2: Fetch all products from production
    log.push({
      timestamp: new Date().toISOString(),
      message: "📥 Fetching products from production store...",
      type: "data_fetch",
    });

    onProgress({
      stage: "fetching",
      message: "Fetching products from production...",
      percentage: 10,
    });

    const productionProducts = await getProductionProducts(
      productionStore,
      accessToken,
    );

    summary.total = productionProducts.length;

    log.push({
      timestamp: new Date().toISOString(),
      message: `Found ${productionProducts.length} products`,
      details: {
        totalProducts: productionProducts.length,
        totalVariants: productionProducts.reduce(
          (sum, product) => sum + (product.variants?.edges?.length || 0),
          0,
        ),
        totalImages: productionProducts.reduce(
          (sum, product) => sum + (product.images?.edges?.length || 0),
          0,
        ),
      },
    });

    if (productionProducts.length === 0) {
      return { summary, log };
    }

    // Step 3: Process each product
    onProgress({
      stage: "processing",
      message: "Processing products...",
      percentage: 20,
    });

    for (let i = 0; i < productionProducts.length; i++) {
      const product = productionProducts[i];
      const progress = 20 + Math.round((i / productionProducts.length) * 70);

      onProgress({
        stage: "processing",
        message: `Processing product ${i + 1}/${productionProducts.length}: ${product.title}`,
        percentage: progress,
      });

      // Force garbage collection every 50 products to prevent memory buildup
      if (i > 0 && i % 50 === 0 && global.gc) {
        global.gc();
        console.log(
          `🧹 Forced garbage collection after processing ${i} products`,
        );
      }

      // Debug logging for images
      console.log(`Product "${product.title}" images:`, {
        hasImages: product.images?.edges?.length > 0,
        imageCount: product.images?.edges?.length || 0,
        firstImageUrl: product.images?.edges?.[0]?.node?.url || "No images",
      });

      log.push({
        timestamp: new Date().toISOString(),
        message: `📋 Processing product: ${product.title} (handle: ${product.handle})`,
        details: {
          productId: product.id,
          status: product.status,
          variants: product.variants?.edges?.length || 0,
          images: product.images?.edges?.length || 0,
          metafields: product.metafields?.nodes?.length || 0,
          productType: product.productType,
          vendor: product.vendor,
        },
      });

      // Check if product already exists in staging
      const existingProduct = await getStagingProductByHandle(
        product.handle,
        stagingAdmin,
      );

      if (existingProduct) {
        // Update existing product
        log.push({
          timestamp: new Date().toISOString(),
          message: `Updating existing product: ${product.title}`,
        });

        const result = await updateProductInStaging(
          existingProduct.id,
          product,
          stagingAdmin,
        );

        if (result.success) {
          summary.updated++;
          log.push({
            timestamp: new Date().toISOString(),
            message: `✅ Successfully updated product: ${product.title}`,
            success: true,
          });

          // Save mapping for updated product
          if (storeConnectionId) {
            try {
              await saveMapping(storeConnectionId, "product", {
                productionId: extractIdFromGid(product.id),
                stagingId: extractIdFromGid(existingProduct.id),
                productionGid: product.id,
                stagingGid: existingProduct.id,
                matchKey: "handle",
                matchValue: product.handle,
                syncId: null,
                title: product.title,
              });
              console.log(`✅ Saved mapping for product: ${product.handle}`);
            } catch (mappingError) {
              console.error(
                `⚠️ Failed to save mapping for product ${product.handle}:`,
                mappingError.message,
              );
            }
          }

          // Publish product to all available sales channels
          await publishProductToAllChannels(
            existingProduct.id,
            stagingAdmin,
          );

          // Sync product metafields after successful update
          if (product.metafields?.nodes?.length > 0) {
            log.push({
              timestamp: new Date().toISOString(),
              message: `🏷️ Syncing metafields for product: ${product.title}`,
              type: "metafields_sync",
            });

            const metafieldsResult = await syncMetafieldValues(
              existingProduct.id,
              "PRODUCT",
              product.metafields.nodes,
              stagingAdmin,
            );

            if (metafieldsResult.success) {
              log.push({
                timestamp: new Date().toISOString(),
                message: `✅ Successfully synced ${metafieldsResult.created + metafieldsResult.updated} metafields for product: ${product.title}`,
                type: "metafields_sync",
                success: true,
                details: {
                  created: metafieldsResult.created,
                  updated: metafieldsResult.updated,
                  skipped: metafieldsResult.skipped,
                  failed: metafieldsResult.failed,
                },
              });
            } else {
              summary.errors.push(
                `Product metafields sync failed for "${product.title}": ${metafieldsResult.error}`,
              );
              log.push({
                timestamp: new Date().toISOString(),
                message: `❌ Product metafields sync failed for "${product.title}": ${metafieldsResult.error}`,
                type: "metafields_sync",
                success: false,
                error: metafieldsResult.error,
              });
            }
          }

          // Update variant data (tracked, SKU, price, etc.) for existing products
          if (product.variants?.edges && existingProduct.variants?.edges) {
            const productionVariants = product.variants.edges.map((e) => e.node);
            let stagingVariants = existingProduct.variants.edges.map((e) => e.node);

            console.log(
              `Product ${product.title} has ${productionVariants.length} production variants and ${stagingVariants.length} staging variants`,
            );

            console.log(`Updating variant data (tracked, SKU, price, etc.) for existing product "${product.title}"...`);
            const variantsUpdateResult = await updateProductVariantsInStaging(
              existingProduct.id,
              productionVariants,
              stagingVariants,
              stagingAdmin,
            );

            if (variantsUpdateResult.success) {
              console.log(
                `✅ Successfully updated ${variantsUpdateResult.variants?.length || 0} variants for "${product.title}"`,
              );
              // Update staging variants reference with fresh data from the bulk update
              if (variantsUpdateResult.variants?.length > 0) {
                stagingVariants = variantsUpdateResult.variants;
                // Rebuild existingProduct.variants.edges with updated data
                existingProduct.variants.edges = stagingVariants.map((v) => ({ node: v }));
              }
            } else {
              console.error(
                `⚠️ Failed to update variant data for "${product.title}": ${variantsUpdateResult.error}`,
              );
            }
          }

          // Sync variant metafields and inventory for existing variants
          if (product.variants?.edges && existingProduct.variants?.edges) {
            console.log(
              `Syncing metafields and inventory for ${product.variants.edges.length} variants of "${product.title}"...`,
            );

            for (const variantEdge of product.variants.edges) {
              const variant = variantEdge.node;
              console.log(
                `Processing variant: ${variant.title} (SKU: ${variant.sku})`,
              );

              // Find corresponding variant in staging (by matching selectedOptions)
              const stagingVariant = existingProduct.variants.edges.find(
                (sv) => {
                  const prodOptions = variant.selectedOptions
                    .map((o) => `${o.name}:${o.value}`)
                    .sort()
                    .join("|");
                  const stagingOptions = sv.node.selectedOptions
                    .map((o) => `${o.name}:${o.value}`)
                    .sort()
                    .join("|");
                  return prodOptions === stagingOptions;
                },
              );

              if (stagingVariant) {
                console.log(
                  `Found matching staging variant: ${stagingVariant.node.title} (ID: ${stagingVariant.node.id})`,
                );

                // Fix 2E: Save variant and inventory_item mappings
                if (storeConnectionId) {
                  try {
                    await saveMapping(storeConnectionId, "variant", {
                      productionId: extractIdFromGid(variant.id),
                      stagingId: extractIdFromGid(stagingVariant.node.id),
                      productionGid: variant.id,
                      stagingGid: stagingVariant.node.id,
                      matchKey: "selectedOptions",
                      matchValue: variant.selectedOptions?.map((o) => `${o.name}:${o.value}`).join("|"),
                      title: variant.title,
                    });
                    if (variant.inventoryItem?.id && stagingVariant.node.inventoryItem?.id) {
                      await saveMapping(storeConnectionId, "inventory_item", {
                        productionId: extractIdFromGid(variant.inventoryItem.id),
                        stagingId: extractIdFromGid(stagingVariant.node.inventoryItem.id),
                        productionGid: variant.inventoryItem.id,
                        stagingGid: stagingVariant.node.inventoryItem.id,
                        matchKey: "variant_sku",
                        matchValue: variant.sku || variant.title,
                      });
                    }
                  } catch (mappingError) {
                    console.warn(`⚠️ Failed to save variant/inventory mapping: ${mappingError.message}`);
                  }
                }

                // Sync metafields if variant has any
                if (variant.metafields?.nodes?.length > 0) {
                  log.push({
                    timestamp: new Date().toISOString(),
                    message: `🏷️ Syncing metafields for variant: ${variant.title}`,
                    type: "variant_metafields_sync",
                  });

                  const variantMetafieldsResult = await syncMetafieldValues(
                    stagingVariant.node.id,
                    "PRODUCTVARIANT",
                    variant.metafields.nodes,
                    stagingAdmin,
                  );

                  if (variantMetafieldsResult.success) {
                    log.push({
                      timestamp: new Date().toISOString(),
                      message: `✅ Successfully synced ${variantMetafieldsResult.created + variantMetafieldsResult.updated} variant metafields for: ${variant.title}`,
                      type: "variant_metafields_sync",
                      success: true,
                    });
                  } else {
                    console.error(
                      `Failed to sync variant metafields:`,
                      variantMetafieldsResult,
                    );
                  }
                }

                // Sync inventory for ALL variants (not just those with metafields)
                if (
                  locationMap.size > 0 &&
                  variant.inventoryItem?.id &&
                  stagingVariant.node.inventoryItem?.id
                ) {
                  console.log(
                    `Syncing inventory for variant: ${variant.title} (SKU: ${variant.sku})`,
                  );
                  console.log(
                    `  Production inventoryItem: ${variant.inventoryItem.id}`,
                  );
                  console.log(
                    `  Staging inventoryItem: ${stagingVariant.node.inventoryItem.id}`,
                  );

                  const inventoryResult = await syncVariantInventory(
                    variant,
                    stagingVariant.node,
                    locationMap,
                    productionAdmin,
                    stagingAdmin,
                  );

                  if (
                    inventoryResult.success &&
                    inventoryResult.synced.length > 0
                  ) {
                    summary.inventory.synced += inventoryResult.synced.length;
                    log.push({
                      timestamp: new Date().toISOString(),
                      message: `✅ Activated inventory for ${variant.sku} across ${inventoryResult.synced.length} locations`,
                      type: "inventory_sync",
                      success: true,
                      details: inventoryResult.synced,
                    });
                  } else if (inventoryResult.failed.length > 0) {
                    summary.inventory.failed += inventoryResult.failed.length;
                    log.push({
                      timestamp: new Date().toISOString(),
                      message: `⚠️ Partial inventory sync for ${variant.sku}: ${inventoryResult.failed.length} locations failed`,
                      type: "inventory_sync",
                      success: false,
                      details: inventoryResult.failed,
                    });
                  }
                } else {
                  if (!variant.inventoryItem?.id) {
                    console.log(
                      `⚠️ Skipping inventory sync - production variant ${variant.sku} has no inventoryItem`,
                    );
                  } else if (!stagingVariant.node.inventoryItem?.id) {
                    console.log(
                      `⚠️ Skipping inventory sync - staging variant has no inventoryItem`,
                    );
                  } else if (locationMap.size === 0) {
                    console.log(
                      `⚠️ Skipping inventory sync - no location mappings found`,
                    );
                  }
                }
              } else {
                console.log(
                  `❌ No matching staging variant found for: ${variant.title} (SKU: ${variant.sku})`,
                );
              }
            }
          }
        } else {
          summary.failed++;
          const errorMessage = `Failed to update product "${product.title}" (handle: ${product.handle}): ${result.error}`;
          summary.errors.push(errorMessage);
          log.push({
            timestamp: new Date().toISOString(),
            message: `❌ ${errorMessage}`,
            success: false,
            error: result.error,
          });
        }
      } else {
        // Create new product
        log.push({
          timestamp: new Date().toISOString(),
          message: `Creating new product: ${product.title}`,
        });

        const result = await createProductInStaging(product, stagingAdmin);

        if (result.success) {
          summary.created++;
          const productDetails = {
            productId: result.product.id,
            title: product.title,
            handle: product.handle,
          };

          // Add variant creation results if available
          if (product.variants?.edges?.length > 0) {
            productDetails.variantsCreated =
              result.product.variants?.edges?.length || 0;
            productDetails.variantsRequested = product.variants.edges.length;
          }

          // Add image upload status if available
          if (product.images?.edges?.length > 0) {
            productDetails.imagesRequested = product.images.edges.length;
          }

          log.push({
            timestamp: new Date().toISOString(),
            message: `✅ Successfully created product: ${product.title}`,
            success: true,
            details: productDetails,
          });

          // Save mapping for created product
          if (storeConnectionId) {
            try {
              await saveMapping(storeConnectionId, "product", {
                productionId: extractIdFromGid(product.id),
                stagingId: extractIdFromGid(result.product.id),
                productionGid: product.id,
                stagingGid: result.product.id,
                matchKey: "handle",
                matchValue: product.handle,
                syncId: null,
                title: product.title,
              });
              console.log(`✅ Saved mapping for product: ${product.handle}`);
            } catch (mappingError) {
              console.error(
                `⚠️ Failed to save mapping for product ${product.handle}:`,
                mappingError.message,
              );
            }
          }

          // Publish the product to all available sales channels
          await publishProductToAllChannels(result.product.id, stagingAdmin);

          // Sync product metafields after successful creation
          if (product.metafields?.nodes?.length > 0 && result.product?.id) {
            log.push({
              timestamp: new Date().toISOString(),
              message: `🏷️ Syncing metafields for new product: ${product.title}`,
              type: "metafields_sync",
            });

            const metafieldsResult = await syncMetafieldValues(
              result.product.id,
              "PRODUCT",
              product.metafields.nodes,
              stagingAdmin,
            );

            if (metafieldsResult.success) {
              log.push({
                timestamp: new Date().toISOString(),
                message: `✅ Successfully synced ${metafieldsResult.created + metafieldsResult.updated} metafields for new product: ${product.title}`,
                type: "metafields_sync",
                success: true,
                details: {
                  created: metafieldsResult.created,
                  updated: metafieldsResult.updated,
                  skipped: metafieldsResult.skipped,
                  failed: metafieldsResult.failed,
                },
              });
            }
          }

          // Sync variant metafields for new variants
          if (product.variants?.edges && result.product?.variants?.edges) {
            for (let j = 0; j < product.variants.edges.length; j++) {
              const variant = product.variants.edges[j].node;

              // Match by selectedOptions instead of array index (Fix 2A)
              const createdVariant = result.product.variants.edges.find(
                (sv) => {
                  const prodOptions = variant.selectedOptions
                    ?.map((o) => `${o.name}:${o.value}`)
                    .sort()
                    .join("|");
                  const stagingOptions = sv.node.selectedOptions
                    ?.map((o) => `${o.name}:${o.value}`)
                    .sort()
                    .join("|");
                  return prodOptions === stagingOptions;
                },
              );

              // Fix 2E: Save variant and inventory_item mappings for new variants
              if (storeConnectionId && createdVariant) {
                try {
                  await saveMapping(storeConnectionId, "variant", {
                    productionId: extractIdFromGid(variant.id),
                    stagingId: extractIdFromGid(createdVariant.node.id),
                    productionGid: variant.id,
                    stagingGid: createdVariant.node.id,
                    matchKey: "selectedOptions",
                    matchValue: variant.selectedOptions?.map((o) => `${o.name}:${o.value}`).join("|"),
                    title: variant.title,
                  });
                  if (variant.inventoryItem?.id && createdVariant.node.inventoryItem?.id) {
                    await saveMapping(storeConnectionId, "inventory_item", {
                      productionId: extractIdFromGid(variant.inventoryItem.id),
                      stagingId: extractIdFromGid(createdVariant.node.inventoryItem.id),
                      productionGid: variant.inventoryItem.id,
                      stagingGid: createdVariant.node.inventoryItem.id,
                      matchKey: "variant_sku",
                      matchValue: variant.sku || variant.title,
                    });
                  }
                } catch (mappingError) {
                  console.warn(`⚠️ Failed to save variant/inventory mapping: ${mappingError.message}`);
                }
              }

              if (variant.metafields?.nodes?.length > 0 && createdVariant) {
                log.push({
                  timestamp: new Date().toISOString(),
                  message: `🏷️ Syncing metafields for new variant: ${variant.title}`,
                  type: "variant_metafields_sync",
                });

                const variantMetafieldsResult = await syncMetafieldValues(
                  createdVariant.node.id,
                  "PRODUCTVARIANT",
                  variant.metafields.nodes,
                  stagingAdmin,
                );

                if (variantMetafieldsResult.success) {
                  log.push({
                    timestamp: new Date().toISOString(),
                    message: `✅ Successfully synced ${variantMetafieldsResult.created + variantMetafieldsResult.updated} variant metafields for new: ${variant.title}`,
                    type: "variant_metafields_sync",
                    success: true,
                  });
                }
              }

              // Sync inventory for this newly created variant if locations are mapped
              if (
                locationMap.size > 0 &&
                variant.inventoryItem?.id &&
                createdVariant
              ) {
                console.log(
                  `Syncing inventory for new variant: ${variant.title} (SKU: ${variant.sku})`,
                );

                const inventoryResult = await syncVariantInventory(
                  variant,
                  createdVariant.node,
                  locationMap,
                  productionAdmin,
                  stagingAdmin,
                );

                if (inventoryResult.success) {
                  summary.inventory.synced += inventoryResult.synced.length;
                  log.push({
                    timestamp: new Date().toISOString(),
                    message: `✅ Synced inventory for new variant ${variant.sku} across ${inventoryResult.synced.length} locations`,
                    type: "inventory_sync",
                    success: true,
                    details: inventoryResult.synced,
                  });
                } else if (inventoryResult.failed.length > 0) {
                  summary.inventory.failed += inventoryResult.failed.length;
                  log.push({
                    timestamp: new Date().toISOString(),
                    message: `⚠️ Partial inventory sync for new variant ${variant.sku}: ${inventoryResult.failed.length} locations failed`,
                    type: "inventory_sync",
                    success: false,
                    details: inventoryResult.failed,
                  });
                }
              }
            }
          }
        } else {
          summary.failed++;
          const errorMessage = `Failed to create product "${product.title}" (handle: ${product.handle}): ${result.error}`;
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
      message: "Product sync completed",
      percentage: 100,
    });

    log.push({
      timestamp: new Date().toISOString(),
      message: `🎉 Product sync completed successfully!`,
      type: "sync_summary",
      success: true,
      details: {
        products: {
          total: summary.total,
          created: summary.created,
          updated: summary.updated,
          failed: summary.failed,
          skipped: summary.skipped,
        },
        totalErrors: summary.errors.length,
        duration: `${((Date.now() - (Date.parse(log[0]?.timestamp) || Date.now())) / 1000).toFixed(1)}s`,
      },
    });

    return { summary, log };
  } catch (error) {
    console.error("Error syncing products:", error);

    const errorMessage = `Product sync failed: ${error.message}`;
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
