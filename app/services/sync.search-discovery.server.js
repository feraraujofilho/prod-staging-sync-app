/**
 * Search & Discovery App Metafields Sync Service
 * Translates product references in Search & Discovery app metafields
 *
 * This service handles metafields from the Search and Discovery app that contain
 * product GIDs (e.g., complementary_products, related_products).
 * It translates production product IDs to staging product IDs using the resource mapping.
 */

import { translateGidsInString } from "../utils/gid-translator.server.js";
import { getMappingByProductionGid } from "./resource-mapping.server.js";

/**
 * Get all products from production with Search & Discovery metafields
 * @param {string} productionStore - Production store domain
 * @param {string} accessToken - Production store access token
 * @returns {Promise<Array>} Array of products with their metafields
 */
async function getProductionProductsWithSearchDiscoveryMetafields(
  productionStore,
  accessToken,
) {
  const products = [];
  let hasNextPage = true;
  let cursor = null;

  const query = `
    query GetProductsWithMetafields($cursor: String) {
      products(first: 50, after: $cursor) {
        edges {
          node {
            id
            title
            handle
            metafields(first: 50, namespace: "shopify--discovery--product_recommendation") {
              edges {
                node {
                  id
                  namespace
                  key
                  value
                  type
                }
              }
            }
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  `;

  while (hasNextPage) {
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
          variables: cursor ? { cursor } : {},
        }),
      },
    );

    const data = await response.json();

    if (data.errors) {
      console.error("GraphQL errors:", data.errors);
      throw new Error(
        `Failed to fetch products: ${JSON.stringify(data.errors)}`,
      );
    }

    const edges = data.data?.products?.edges || [];
    const pageInfo = data.data?.products?.pageInfo;

    // Filter products that actually have Search & Discovery metafields
    const productsWithMetafields = edges
      .map((edge) => edge.node)
      .filter(
        (product) => product.metafields && product.metafields.edges.length > 0,
      );

    products.push(...productsWithMetafields);

    hasNextPage = pageInfo?.hasNextPage || false;
    cursor = pageInfo?.endCursor;
  }

  return products;
}

/**
 * Translate product GIDs in a metafield value
 * @param {string} storeConnectionId - Store connection ID
 * @param {string} value - Metafield value (JSON array of product GIDs)
 * @param {string} context - Context for logging
 * @returns {Promise<Object>} Translation result
 */
async function translateProductReferences(storeConnectionId, value, context) {
  try {
    // Parse the JSON array of product GIDs
    const productGids = JSON.parse(value);

    if (!Array.isArray(productGids)) {
      return {
        success: false,
        error: "Value is not an array",
        originalValue: value,
      };
    }

    const translatedGids = [];
    const unmappedGids = [];

    // Translate each product GID
    for (const prodGid of productGids) {
      const mapping = await getMappingByProductionGid(
        storeConnectionId,
        prodGid,
      );

      if (mapping && mapping.stagingGid) {
        translatedGids.push(mapping.stagingGid);
      } else {
        unmappedGids.push(prodGid);
        console.warn(
          `⚠️ No mapping found for product ${prodGid} in ${context}`,
        );
      }
    }

    // Only return translated value if all GIDs were successfully mapped
    if (unmappedGids.length === 0 && translatedGids.length > 0) {
      return {
        success: true,
        translatedValue: JSON.stringify(translatedGids),
        originalValue: value,
        translated: translatedGids.length,
        unmapped: 0,
      };
    }

    return {
      success: false,
      translatedValue: null,
      originalValue: value,
      translated: translatedGids.length,
      unmapped: unmappedGids.length,
      unmappedGids,
      error: `${unmappedGids.length} product(s) could not be mapped`,
    };
  } catch (error) {
    console.error(`Error translating product references in ${context}:`, error);
    return {
      success: false,
      error: error.message,
      originalValue: value,
    };
  }
}

/**
 * Update a product's metafield in staging
 * @param {string} productId - Staging product GID
 * @param {string} namespace - Metafield namespace
 * @param {string} key - Metafield key
 * @param {string} value - New metafield value
 * @param {string} type - Metafield type
 * @param {Object} stagingAdmin - Shopify admin API client
 * @returns {Promise<Object>} Update result
 */
async function updateProductMetafield(
  productId,
  namespace,
  key,
  value,
  type,
  stagingAdmin,
) {
  const mutation = `
    mutation updateProductMetafield($product: ProductInput!) {
      productUpdate(input: $product) {
        product {
          id
          title
          metafield(namespace: "${namespace}", key: "${key}") {
            id
            namespace
            key
            value
            type
          }
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const variables = {
    product: {
      id: productId,
      metafields: [
        {
          namespace,
          key,
          type,
          value,
        },
      ],
    },
  };

  try {
    const response = await stagingAdmin.graphql(mutation, { variables });
    const data = await response.json();

    if (data.errors) {
      return {
        success: false,
        errors: JSON.stringify(data.errors),
      };
    }

    const userErrors = data.data?.productUpdate?.userErrors || [];

    if (userErrors.length > 0) {
      return {
        success: false,
        errors: userErrors.map((e) => e.message).join(", "),
      };
    }

    return {
      success: true,
      product: data.data.productUpdate.product,
    };
  } catch (error) {
    console.error("Error updating product metafield:", error);
    return {
      success: false,
      errors: error.message,
    };
  }
}

/**
 * Main sync function for Search & Discovery metafields
 * @param {string} productionStore - Production store domain
 * @param {string} accessToken - Production store access token
 * @param {Object} stagingAdmin - Shopify admin API client for staging
 * @param {string} storeConnectionId - Store connection ID
 * @param {Function} onProgress - Progress callback
 * @returns {Promise<Object>} Sync summary
 */
export async function syncSearchDiscoveryMetafields(
  productionStore,
  accessToken,
  stagingAdmin,
  storeConnectionId,
  onProgress = () => {},
) {
  const log = [];
  const summary = {
    total: 0,
    updated: 0,
    skipped: 0,
    failed: 0,
    errors: [],
    metafieldsProcessed: 0,
    metafieldsUpdated: 0,
    metafieldsSkipped: 0,
    unmappedReferences: 0,
  };

  try {
    log.push({
      timestamp: new Date().toISOString(),
      message:
        "🔍 Starting Search & Discovery metafields sync (translating product references)",
      type: "sync_start",
    });

    onProgress({
      stage: "fetching",
      message:
        "Fetching products with Search & Discovery metafields from production...",
      percentage: 0,
    });

    // Step 1: Get all products from production with Search & Discovery metafields
    const productionProducts =
      await getProductionProductsWithSearchDiscoveryMetafields(
        productionStore,
        accessToken,
      );

    summary.total = productionProducts.length;

    log.push({
      timestamp: new Date().toISOString(),
      message: `Found ${productionProducts.length} products with Search & Discovery metafields in production`,
    });

    if (productionProducts.length === 0) {
      log.push({
        timestamp: new Date().toISOString(),
        message:
          "ℹ️ No products found with Search & Discovery metafields in production. Nothing to sync.",
      });
      return { summary, log };
    }

    onProgress({
      stage: "processing",
      message: "Translating and updating metafields...",
      percentage: 10,
    });

    // Step 2: Process each production product
    for (let i = 0; i < productionProducts.length; i++) {
      const productionProduct = productionProducts[i];
      const progress =
        10 + Math.round(((i + 1) / productionProducts.length) * 85);

      onProgress({
        stage: "processing",
        message: `Processing product: ${productionProduct.title}`,
        percentage: progress,
      });

      log.push({
        timestamp: new Date().toISOString(),
        message: `📦 Processing production product: ${productionProduct.title} (${productionProduct.handle})`,
        details: {
          productionProductId: productionProduct.id,
          metafieldsCount: productionProduct.metafields.edges.length,
        },
      });

      // Step 2.1: Find corresponding staging product using the mapping
      const productMapping = await getMappingByProductionGid(
        storeConnectionId,
        productionProduct.id,
      );

      if (!productMapping) {
        summary.skipped++;
        log.push({
          timestamp: new Date().toISOString(),
          message: `⚠️ Skipped product ${productionProduct.title} - no mapping found (product not synced to staging)`,
          warning: true,
        });
        continue;
      }

      const stagingProductId = productMapping.stagingGid;

      log.push({
        timestamp: new Date().toISOString(),
        message: `✓ Found staging product mapping: ${productionProduct.id} → ${stagingProductId}`,
      });

      // Process each metafield
      let productUpdated = false;
      for (const metafieldEdge of productionProduct.metafields.edges) {
        const metafield = metafieldEdge.node;
        summary.metafieldsProcessed++;

        // Only process list.product_reference type metafields
        if (metafield.type !== "list.product_reference") {
          log.push({
            timestamp: new Date().toISOString(),
            message: `⏭️ Skipping metafield ${metafield.namespace}.${metafield.key} (type: ${metafield.type})`,
          });
          summary.metafieldsSkipped++;
          continue;
        }

        const context = `product:${productionProduct.id} metafield:${metafield.namespace}.${metafield.key}`;

        // Translate product references in the metafield value
        const translationResult = await translateProductReferences(
          storeConnectionId,
          metafield.value,
          context,
        );

        if (translationResult.success) {
          // Create/update the metafield on the staging product with translated value
          log.push({
            timestamp: new Date().toISOString(),
            message: `🔄 Creating/updating metafield ${metafield.namespace}.${metafield.key} on staging product with translated product references`,
            details: {
              productionValue: translationResult.originalValue,
              stagingValue: translationResult.translatedValue,
              translated: translationResult.translated,
            },
          });

          const updateResult = await updateProductMetafield(
            stagingProductId,
            metafield.namespace,
            metafield.key,
            translationResult.translatedValue,
            metafield.type,
            stagingAdmin,
          );

          if (updateResult.success) {
            summary.metafieldsUpdated++;
            productUpdated = true;
            log.push({
              timestamp: new Date().toISOString(),
              message: `✅ Successfully created/updated metafield ${metafield.namespace}.${metafield.key} on staging product`,
              success: true,
            });
          } else {
            summary.failed++;
            summary.errors.push(
              `Failed to update ${metafield.namespace}.${metafield.key} for product ${productionProduct.title}: ${updateResult.errors}`,
            );
            log.push({
              timestamp: new Date().toISOString(),
              message: `❌ Failed to update metafield on staging product: ${updateResult.errors}`,
              error: updateResult.errors,
            });
          }
        } else {
          // Translation failed due to unmapped references
          summary.metafieldsSkipped++;
          summary.unmappedReferences += translationResult.unmapped || 0;

          log.push({
            timestamp: new Date().toISOString(),
            message: `⚠️ Skipped metafield ${metafield.namespace}.${metafield.key} due to unmapped product references`,
            warning: true,
            details: {
              error: translationResult.error,
              unmappedGids: translationResult.unmappedGids,
              originalValue: translationResult.originalValue,
            },
          });
        }
      }

      // Update product summary
      if (productUpdated) {
        summary.updated++;
        log.push({
          timestamp: new Date().toISOString(),
          message: `✅ Successfully synced Search & Discovery metafields for product: ${productionProduct.title}`,
          success: true,
        });
      } else {
        summary.skipped++;
        log.push({
          timestamp: new Date().toISOString(),
          message: `⏭️ Skipped product: ${productionProduct.title} (no metafields updated)`,
        });
      }
    }

    // Final summary
    onProgress({
      stage: "complete",
      message: "Search & Discovery metafields sync completed",
      percentage: 100,
    });

    log.push({
      timestamp: new Date().toISOString(),
      message: "🎉 Search & Discovery metafields sync completed",
      type: "sync_complete",
      summary: {
        totalProducts: summary.total,
        productsUpdated: summary.updated,
        productsSkipped: summary.skipped,
        productsFailed: summary.failed,
        metafieldsProcessed: summary.metafieldsProcessed,
        metafieldsUpdated: summary.metafieldsUpdated,
        metafieldsSkipped: summary.metafieldsSkipped,
        unmappedReferences: summary.unmappedReferences,
      },
    });

    return { summary, log };
  } catch (error) {
    console.error("Error in Search & Discovery metafields sync:", error);

    const errorMessage = `Search & Discovery metafields sync failed: ${error.message}`;
    summary.errors.push(errorMessage);

    log.push({
      timestamp: new Date().toISOString(),
      message: `❌ ${errorMessage}`,
      error: error.message,
      stack: error.stack,
    });

    return { summary, log };
  }
}
