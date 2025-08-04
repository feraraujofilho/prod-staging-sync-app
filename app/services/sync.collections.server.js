/**
 * Collection sync service for Shopify stores
 * Syncs collections, their products, and related metafields from production to staging using GraphQL Admin API
 */

import {
  syncMetafieldValues,
  syncMetafieldDefinitions,
} from "./sync.metafields.server.js";

/**
 * Get all collections from production store
 * @param {string} productionStore - The production store domain
 * @param {string} accessToken - The production store access token
 * @param {number} first - Number of collections to fetch per page
 * @returns {Promise<Array>} Array of collection objects
 */
async function getProductionCollections(
  productionStore,
  accessToken,
  first = 50,
) {
  const query = `
    query GetCollections($first: Int!, $after: String) {
      collections(first: $first, after: $after) {
        edges {
          node {
            id
            handle
            title
            description
            descriptionHtml
            sortOrder
            templateSuffix
            seo {
              title
              description
            }
            image {
              id
              url
              altText
              width
              height
            }
            ruleSet {
              appliedDisjunctively
              rules {
                column
                relation
                condition
              }
            }
            products(first: 250) {
              edges {
                node {
                  id
                  handle
                  title
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
          cursor
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  `;

  const allCollections = [];
  let hasNextPage = true;
  let after = null;

  try {
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
            variables: { first, after },
          }),
        },
      );

      const data = await response.json();

      if (data.errors) {
        throw new Error(
          `GraphQL errors: ${data.errors.map((e) => e.message).join(", ")}`,
        );
      }

      const collections = data.data.collections.edges.map((edge) => edge.node);
      allCollections.push(...collections);

      hasNextPage = data.data.collections.pageInfo.hasNextPage;
      after = data.data.collections.pageInfo.endCursor;

      // Add a small delay to avoid rate limiting
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    return allCollections;
  } catch (error) {
    console.error("Error fetching collections from production:", error);
    throw error;
  }
}

/**
 * Check if a collection exists in staging by handle
 * @param {string} handle - The collection handle
 * @param {Object} stagingAdmin - Shopify admin API client for staging
 * @returns {Promise<Object|null>} Collection object if exists, null otherwise
 */
async function getStagingCollectionByHandle(handle, stagingAdmin) {
  const query = `
    query GetCollectionByHandle($handle: String!) {
      collectionByHandle(handle: $handle) {
        id
        handle
        title
        description
        sortOrder
        products(first: 250) {
          edges {
            node {
              id
              handle
            }
          }
        }
      }
    }
  `;

  try {
    const variables = { handle };
    const response = await stagingAdmin.graphql(query, { variables });
    const result = await response.json();

    if (result.errors) {
      console.error("Error getting staging collection:", result.errors);
      return null;
    }

    return result.data?.collectionByHandle || null;
  } catch (error) {
    console.error("Error getting staging collection by handle:", error);
    return null;
  }
}

/**
 * Find products in staging by handles
 * @param {Array} productHandles - Array of product handles
 * @param {Object} stagingAdmin - Shopify admin API client for staging
 * @returns {Promise<Array>} Array of product IDs that exist in staging
 */
async function findStagingProductsByHandles(productHandles, stagingAdmin) {
  if (!productHandles || productHandles.length === 0) {
    return [];
  }

  const query = `
    query GetProductsByHandles($handles: [String!]!) {
      products(first: 250, query: $handles) {
        edges {
          node {
            id
            handle
          }
        }
      }
    }
  `;

  try {
    // Create query string for multiple handles
    const handleQuery = productHandles
      .map((handle) => `handle:${handle}`)
      .join(" OR ");

    console.log(`Searching for products with query: ${handleQuery}`);
    console.log(`Product handles to find: ${productHandles.join(", ")}`);

    const variables = { handles: handleQuery };
    const response = await stagingAdmin.graphql(query, { variables });
    const result = await response.json();

    if (result.errors) {
      console.error("Error finding staging products:", result.errors);
      return [];
    }

    const foundProducts =
      result.data?.products?.edges?.map((edge) => edge.node) || [];
    console.log(`Found ${foundProducts.length} products in staging:`);
    foundProducts.forEach((p) => console.log(`  - ${p.handle} (${p.id})`));

    return foundProducts.map((p) => p.id);
  } catch (error) {
    console.error("Error finding staging products by handles:", error);
    return [];
  }
}

/**
 * Create a new collection in staging
 * @param {Object} collection - The collection object from production
 * @param {Object} stagingAdmin - Shopify admin API client for staging
 * @returns {Promise<Object>} Result object with success status and collection data
 */
async function createCollectionInStaging(collection, stagingAdmin) {
  const mutation = `
    mutation collectionCreate($input: CollectionInput!) {
      collectionCreate(input: $input) {
        collection {
          id
          handle
          title
          descriptionHtml
          sortOrder
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  try {
    // Prepare collection input
    const input = {
      title: collection.title,
      handle: collection.handle,
      descriptionHtml: collection.descriptionHtml || collection.description,
      sortOrder: collection.sortOrder,
      templateSuffix: collection.templateSuffix,
    };

    // Add SEO if present
    if (collection.seo) {
      input.seo = {
        title: collection.seo.title,
        description: collection.seo.description,
      };
    }

    // Add image if present
    if (collection.image) {
      input.image = {
        src: collection.image.url,
        altText: collection.image.altText,
      };
    }

    // Add rule set for smart collections
    if (
      collection.ruleSet &&
      collection.ruleSet.rules &&
      collection.ruleSet.rules.length > 0
    ) {
      input.ruleSet = {
        appliedDisjunctively: collection.ruleSet.appliedDisjunctively,
        rules: collection.ruleSet.rules.map((rule) => ({
          column: rule.column,
          relation: rule.relation,
          condition: rule.condition,
        })),
      };
    }

    const variables = { input };
    const response = await stagingAdmin.graphql(mutation, { variables });
    const result = await response.json();

    console.log(
      `Collection creation result for "${collection.title}":`,
      JSON.stringify(result, null, 2),
    );

    if (result.errors) {
      const errors = result.errors.map((e) => e.message).join(", ");
      throw new Error(`GraphQL errors: ${errors}`);
    }

    if (result.data?.collectionCreate?.userErrors?.length > 0) {
      const errors = result.data.collectionCreate.userErrors
        .map((e) => e.message)
        .join(", ");
      throw new Error(
        `Failed to create collection "${collection.title}" (handle: ${collection.handle}): ${errors}`,
      );
    }

    if (!result.data?.collectionCreate?.collection) {
      throw new Error(
        `Failed to create collection "${collection.title}" (handle: ${collection.handle}): No collection returned from API`,
      );
    }

    return {
      success: true,
      collection: result.data.collectionCreate.collection,
    };
  } catch (error) {
    console.error(`Error creating collection "${collection.title}":`, error);
    return {
      success: false,
      error: error.message || "Unknown error occurred",
    };
  }
}

/**
 * Update an existing collection in staging
 * @param {string} collectionId - The collection ID in staging
 * @param {Object} collection - The collection object from production
 * @param {Object} stagingAdmin - Shopify admin API client for staging
 * @returns {Promise<Object>} Result object with success status and collection data
 */
async function updateCollectionInStaging(
  collectionId,
  collection,
  stagingAdmin,
) {
  const mutation = `
    mutation collectionUpdate($input: CollectionInput!) {
      collectionUpdate(input: $input) {
        collection {
          id
          handle
          title
          descriptionHtml
          sortOrder
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  try {
    // Prepare collection input for update
    const input = {
      id: collectionId,
      title: collection.title,
      descriptionHtml: collection.descriptionHtml || collection.description,
      sortOrder: collection.sortOrder,
      templateSuffix: collection.templateSuffix,
    };

    // Add SEO if present
    if (collection.seo) {
      input.seo = {
        title: collection.seo.title,
        description: collection.seo.description,
      };
    }

    const variables = { input };
    const response = await stagingAdmin.graphql(mutation, { variables });
    const result = await response.json();

    console.log(
      `Collection update result for "${collection.title}":`,
      JSON.stringify(result, null, 2),
    );

    if (result.errors) {
      const errors = result.errors.map((e) => e.message).join(", ");
      throw new Error(`GraphQL errors: ${errors}`);
    }

    if (result.data?.collectionUpdate?.userErrors?.length > 0) {
      const errors = result.data.collectionUpdate.userErrors
        .map((e) => e.message)
        .join(", ");
      throw new Error(
        `Failed to update collection "${collection.title}" (handle: ${collection.handle}): ${errors}`,
      );
    }

    return {
      success: true,
      collection: result.data.collectionUpdate.collection,
    };
  } catch (error) {
    console.error(`Error updating collection "${collection.title}":`, error);
    return {
      success: false,
      error: error.message || "Unknown error occurred",
    };
  }
}

/**
 * Add products to a collection
 * @param {string} collectionId - The collection ID in staging
 * @param {Array} productIds - Array of product IDs to add
 * @param {Object} stagingAdmin - Shopify admin API client for staging
 * @returns {Promise<Object>} Result object with success status
 */
async function addProductsToCollection(collectionId, productIds, stagingAdmin) {
  if (!productIds || productIds.length === 0) {
    return { success: true, message: "No products to add" };
  }

  const mutation = `
    mutation collectionAddProducts($id: ID!, $productIds: [ID!]!) {
      collectionAddProducts(id: $id, productIds: $productIds) {
        collection {
          id
          title
          productsCount
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  try {
    const variables = { id: collectionId, productIds };
    const response = await stagingAdmin.graphql(mutation, { variables });
    const result = await response.json();

    if (result.errors) {
      const errors = result.errors.map((e) => e.message).join(", ");
      throw new Error(`GraphQL errors: ${errors}`);
    }

    if (result.data?.collectionAddProducts?.userErrors?.length > 0) {
      const errors = result.data.collectionAddProducts.userErrors
        .map((e) => e.message)
        .join(", ");
      throw new Error(`Failed to add products to collection: ${errors}`);
    }

    return {
      success: true,
      productsAdded: productIds.length,
      collection: result.data?.collectionAddProducts?.collection,
    };
  } catch (error) {
    console.error(
      `Error adding products to collection ${collectionId}:`,
      error,
    );
    return {
      success: false,
      error: error.message || "Unknown error occurred",
    };
  }
}

/**
 * Sync collections from production to staging
 * @param {string} productionStore - The production store domain
 * @param {string} accessToken - The production store access token
 * @param {Object} stagingAdmin - Shopify admin API client for staging
 * @param {Function} onProgress - Progress callback function
 * @returns {Promise<Object>} Sync summary
 */
export async function syncCollections(
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
    productsAdded: 0,
    errors: [],
  };

  try {
    // Add initial summary log
    log.push({
      timestamp: new Date().toISOString(),
      message: "🚀 Starting collections sync operation",
      type: "sync_start",
      details: {
        productionStore,
        timestamp: new Date().toISOString(),
        operation: "collections_sync",
      },
    });

    // Step 1: Sync metafield definitions for COLLECTION owner type
    log.push({
      timestamp: new Date().toISOString(),
      message:
        "🔧 Syncing collection metafield definitions before processing collections...",
      type: "metafield_definitions_sync",
    });

    onProgress({
      stage: "metafield_definitions",
      message: "Syncing collection metafield definitions...",
      percentage: 5,
    });

    try {
      const metafieldDefinitionsResult = await syncMetafieldDefinitions(
        productionStore,
        accessToken,
        stagingAdmin,
        "COLLECTION", // Only sync COLLECTION metafield definitions
      );

      if (metafieldDefinitionsResult.success) {
        log.push({
          timestamp: new Date().toISOString(),
          message: `✅ Successfully synced collection metafield definitions`,
          type: "metafield_definitions_sync",
          success: true,
          details: metafieldDefinitionsResult.summary,
        });
      } else {
        log.push({
          timestamp: new Date().toISOString(),
          message: `⚠️ Collection metafield definitions sync had issues: ${metafieldDefinitionsResult.error || "Unknown error"}`,
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

    // Step 2: Fetch all collections from production
    log.push({
      timestamp: new Date().toISOString(),
      message: "📥 Fetching collections from production store...",
      type: "data_fetch",
    });

    onProgress({
      stage: "fetching",
      message: "Fetching collections from production...",
      percentage: 10,
    });

    const productionCollections = await getProductionCollections(
      productionStore,
      accessToken,
    );

    summary.total = productionCollections.length;

    log.push({
      timestamp: new Date().toISOString(),
      message: `Found ${productionCollections.length} collections`,
      details: {
        totalCollections: productionCollections.length,
        totalProducts: productionCollections.reduce(
          (sum, collection) => sum + (collection.products?.edges?.length || 0),
          0,
        ),
        smartCollections: productionCollections.filter(
          (c) => c.ruleSet && c.ruleSet.rules && c.ruleSet.rules.length > 0,
        ).length,
        manualCollections: productionCollections.filter(
          (c) => !c.ruleSet || !c.ruleSet.rules || c.ruleSet.rules.length === 0,
        ).length,
      },
    });

    if (productionCollections.length === 0) {
      return { summary, log };
    }

    // Step 3: Process each collection
    onProgress({
      stage: "processing",
      message: "Processing collections...",
      percentage: 20,
    });

    for (let i = 0; i < productionCollections.length; i++) {
      const collection = productionCollections[i];
      const progress = 20 + Math.round((i / productionCollections.length) * 70);

      onProgress({
        stage: "processing",
        message: `Processing collection: ${collection.title}`,
        percentage: progress,
      });

      log.push({
        timestamp: new Date().toISOString(),
        message: `📋 Processing collection: ${collection.title} (handle: ${collection.handle})`,
        details: {
          collectionId: collection.id,
          products: collection.products?.edges?.length || 0,
          metafields: collection.metafields?.nodes?.length || 0,
          sortOrder: collection.sortOrder,
          isSmartCollection: !!(
            collection.ruleSet &&
            collection.ruleSet.rules &&
            collection.ruleSet.rules.length > 0
          ),
        },
      });

      // Check if collection already exists in staging
      const existingCollection = await getStagingCollectionByHandle(
        collection.handle,
        stagingAdmin,
      );

      if (existingCollection) {
        // Update existing collection
        log.push({
          timestamp: new Date().toISOString(),
          message: `Updating existing collection: ${collection.title}`,
        });

        const result = await updateCollectionInStaging(
          existingCollection.id,
          collection,
          stagingAdmin,
        );

        if (result.success) {
          summary.updated++;
          log.push({
            timestamp: new Date().toISOString(),
            message: `✅ Successfully updated collection: ${collection.title}`,
            success: true,
          });

          // Add products to manual collections (smart collections handle this automatically)
          if (
            collection.products?.edges?.length > 0 &&
            (!collection.ruleSet ||
              !collection.ruleSet.rules ||
              collection.ruleSet.rules.length === 0)
          ) {
            const productHandles = collection.products.edges.map(
              (edge) => edge.node.handle,
            );
            const stagingProductIds = await findStagingProductsByHandles(
              productHandles,
              stagingAdmin,
            );

            if (stagingProductIds.length > 0) {
              log.push({
                timestamp: new Date().toISOString(),
                message: `🔗 Adding ${stagingProductIds.length} products to collection: ${collection.title}`,
                type: "products_sync",
              });

              const addProductsResult = await addProductsToCollection(
                existingCollection.id,
                stagingProductIds,
                stagingAdmin,
              );

              if (addProductsResult.success) {
                summary.productsAdded += addProductsResult.productsAdded || 0;
                log.push({
                  timestamp: new Date().toISOString(),
                  message: `✅ Successfully added ${addProductsResult.productsAdded} products to collection: ${collection.title}`,
                  type: "products_sync",
                  success: true,
                });
              } else {
                log.push({
                  timestamp: new Date().toISOString(),
                  message: `❌ Failed to add products to collection "${collection.title}": ${addProductsResult.error}`,
                  type: "products_sync",
                  success: false,
                  error: addProductsResult.error,
                });
              }
            } else {
              log.push({
                timestamp: new Date().toISOString(),
                message: `⚠️ No matching products found in staging for collection: ${collection.title}`,
                type: "products_sync",
                skipped: true,
              });
            }
          }

          // Sync collection metafields after successful update
          if (collection.metafields?.nodes?.length > 0) {
            log.push({
              timestamp: new Date().toISOString(),
              message: `🏷️ Syncing metafields for collection: ${collection.title}`,
              type: "metafields_sync",
            });

            const metafieldsResult = await syncMetafieldValues(
              existingCollection.id,
              "COLLECTION",
              collection.metafields.nodes,
              stagingAdmin,
            );

            if (metafieldsResult.success) {
              log.push({
                timestamp: new Date().toISOString(),
                message: `✅ Successfully synced ${metafieldsResult.created + metafieldsResult.updated} metafields for collection: ${collection.title}`,
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
                `Collection metafields sync failed for "${collection.title}": ${metafieldsResult.error}`,
              );
              log.push({
                timestamp: new Date().toISOString(),
                message: `❌ Collection metafields sync failed for "${collection.title}": ${metafieldsResult.error}`,
                type: "metafields_sync",
                success: false,
                error: metafieldsResult.error,
              });
            }
          }
        } else {
          summary.failed++;
          const errorMessage = `Failed to update collection "${collection.title}" (handle: ${collection.handle}): ${result.error}`;
          summary.errors.push(errorMessage);
          log.push({
            timestamp: new Date().toISOString(),
            message: `❌ ${errorMessage}`,
            success: false,
            error: result.error,
          });
        }
      } else {
        // Create new collection
        log.push({
          timestamp: new Date().toISOString(),
          message: `Creating new collection: ${collection.title}`,
        });

        const result = await createCollectionInStaging(
          collection,
          stagingAdmin,
        );

        if (result.success) {
          summary.created++;
          log.push({
            timestamp: new Date().toISOString(),
            message: `✅ Successfully created collection: ${collection.title}`,
            success: true,
          });

          // Add products to manual collections (smart collections handle this automatically)
          if (
            collection.products?.edges?.length > 0 &&
            result.collection?.id &&
            (!collection.ruleSet ||
              !collection.ruleSet.rules ||
              collection.ruleSet.rules.length === 0)
          ) {
            const productHandles = collection.products.edges.map(
              (edge) => edge.node.handle,
            );
            const stagingProductIds = await findStagingProductsByHandles(
              productHandles,
              stagingAdmin,
            );

            if (stagingProductIds.length > 0) {
              log.push({
                timestamp: new Date().toISOString(),
                message: `🔗 Adding ${stagingProductIds.length} products to new collection: ${collection.title}`,
                type: "products_sync",
              });

              const addProductsResult = await addProductsToCollection(
                result.collection.id,
                stagingProductIds,
                stagingAdmin,
              );

              if (addProductsResult.success) {
                summary.productsAdded += addProductsResult.productsAdded || 0;
                log.push({
                  timestamp: new Date().toISOString(),
                  message: `✅ Successfully added ${addProductsResult.productsAdded} products to new collection: ${collection.title}`,
                  type: "products_sync",
                  success: true,
                });
              } else {
                log.push({
                  timestamp: new Date().toISOString(),
                  message: `❌ Failed to add products to new collection "${collection.title}": ${addProductsResult.error}`,
                  type: "products_sync",
                  success: false,
                  error: addProductsResult.error,
                });
              }
            } else {
              log.push({
                timestamp: new Date().toISOString(),
                message: `⚠️ No matching products found in staging for new collection: ${collection.title}`,
                type: "products_sync",
                skipped: true,
              });
            }
          }

          // Sync collection metafields after successful creation
          if (
            collection.metafields?.nodes?.length > 0 &&
            result.collection?.id
          ) {
            log.push({
              timestamp: new Date().toISOString(),
              message: `🏷️ Syncing metafields for new collection: ${collection.title}`,
              type: "metafields_sync",
            });

            const metafieldsResult = await syncMetafieldValues(
              result.collection.id,
              "COLLECTION",
              collection.metafields.nodes,
              stagingAdmin,
            );

            if (metafieldsResult.success) {
              log.push({
                timestamp: new Date().toISOString(),
                message: `✅ Successfully synced ${metafieldsResult.created + metafieldsResult.updated} metafields for new collection: ${collection.title}`,
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
        } else {
          summary.failed++;
          const errorMessage = `Failed to create collection "${collection.title}" (handle: ${collection.handle}): ${result.error}`;
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
      message: "Collection sync completed",
      percentage: 100,
    });

    log.push({
      timestamp: new Date().toISOString(),
      message: `🎉 Collection sync completed successfully!`,
      type: "sync_summary",
      success: true,
      details: {
        collections: {
          total: summary.total,
          created: summary.created,
          updated: summary.updated,
          failed: summary.failed,
          skipped: summary.skipped,
        },
        productsAdded: summary.productsAdded,
        totalErrors: summary.errors.length,
        duration: `${((Date.now() - (Date.parse(log[0]?.timestamp) || Date.now())) / 1000).toFixed(1)}s`,
      },
    });

    return { summary, log };
  } catch (error) {
    console.error("Error syncing collections:", error);

    const errorMessage = `Collection sync failed: ${error.message}`;
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
