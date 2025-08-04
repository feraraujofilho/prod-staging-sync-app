/**
 * Product sync service for Shopify stores
 * Syncs products, variants, and related metafields from production to staging using GraphQL Admin API
 */

import {
  syncMetafieldValues,
  syncMetafieldDefinitions,
} from "./sync.metafields.server.js";

/**
 * Get all products from production store
 * @param {string} productionStore - The production store domain
 * @param {string} accessToken - The production store access token
 * @param {number} first - Number of products to fetch per page
 * @returns {Promise<Array>} Array of product objects
 */
async function getProductionProducts(productionStore, accessToken, first = 50) {
  console.log("Fetching products from production:", {
    store: productionStore,
    hasToken: !!accessToken,
    tokenLength: accessToken?.length || 0,
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
            variants(first: 100) {
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
                  inventoryQuantity
                  position
                  selectedOptions {
                    name
                    value
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
            images(first: 10) {
              edges {
                node {
                  id
                  url
                  altText
                  width
                  height
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

  const allProducts = [];
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
                imagesStructure: data.data.products.edges[0].node?.images,
              }
            : "No products",
        });
      }

      if (data.errors) {
        throw new Error(
          `GraphQL errors: ${data.errors.map((e) => e.message).join(", ")}`,
        );
      }

      const products = data.data.products.edges.map((edge) => edge.node);

      // Debug: Check first product for images
      if (products.length > 0) {
        console.log(`First product from production:`, {
          title: products[0].title,
          hasImages: !!products[0].images,
          imageEdges: products[0].images?.edges?.length || 0,
          firstImage: products[0].images?.edges?.[0]?.node || "No images",
        });
      }

      allProducts.push(...products);

      hasNextPage = data.data.products.pageInfo.hasNextPage;
      after = data.data.products.pageInfo.endCursor;

      // Add a small delay to avoid rate limiting
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

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
    query GetProductByHandle($handle: String!) {
      productByHandle(handle: $handle) {
        id
        handle
        title
        status
        variants(first: 100) {
          edges {
            node {
              id
              sku
              title
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
      console.error("Error getting staging product:", result.errors);
      return null;
    }

    return result.data?.productByHandle || null;
  } catch (error) {
    console.error("Error getting staging product by handle:", error);
    return null;
  }
}

/**
 * Update variants for a product in staging
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
    mutation productVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
      productVariantsBulkUpdate(productId: $productId, variants: $variants) {
        productVariants {
          id
          title
          sku
          barcode
          price
          compareAtPrice
          inventoryQuantity
          position
          selectedOptions {
            name
            value
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
    // Match production variants to staging variants by option values
    const variantUpdates = [];

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
        variantUpdates.push({
          id: stagingVariant.id,
          sku: prodVariant.sku,
          barcode: prodVariant.barcode,
          price: prodVariant.price,
          compareAtPrice: prodVariant.compareAtPrice,
          inventoryPolicy: "CONTINUE",
          inventoryTracked: false,
          position: prodVariant.position,
        });
      } else {
        console.warn(
          `  ❌ No matching staging variant found for: ${prodVariant.title}`,
        );
      }
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

    console.log(`Updating ${variantUpdates.length} variants`);

    const variables = {
      productId,
      variants: variantUpdates,
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
    mutation productVariantsBulkCreate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
      productVariantsBulkCreate(productId: $productId, variants: $variants) {
        productVariants {
          id
          title
          sku
          barcode
          price
          compareAtPrice
          inventoryQuantity
          position
          selectedOptions {
            name
            value
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
    // Prepare variant inputs
    const variantInputs = variants.map((variant) => ({
      sku: variant.sku,
      barcode: variant.barcode,
      price: variant.price,
      compareAtPrice: variant.compareAtPrice,
      taxable: variant.taxable,
      inventoryPolicy: "CONTINUE", // Always set to not track quantity
      inventoryTracked: false, // Don't track inventory
      position: variant.position,
      optionValues: variant.selectedOptions.map((option) => ({
        optionName: option.name,
        name: option.value,
      })),
    }));

    const variables = {
      productId,
      variants: variantInputs,
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
        images(first: 100) {
          edges {
            node {
              id
              url
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

    if (result.data?.product?.images?.edges) {
      return result.data.product.images.edges.length;
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
            image {
              url
              altText
            }
          }
        }
        mediaUserErrors {
          field
          message
          code
        }
      }
    }
  `;

  try {
    // Prepare media inputs
    const mediaInputs = images.map((image) => ({
      originalSource: image.url,
      alt: image.altText || "",
      mediaContentType: "IMAGE",
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
    // Note: productCreate with productOptions automatically creates a default variant
    // We need to handle this when creating additional variants
    if (product.variants?.edges?.length > 0) {
      const variants = product.variants.edges.map((edge) => edge.node);

      console.log(
        `Product "${product.title}" has ${variants.length} variants from production`,
      );
      variants.forEach((v, i) => {
        console.log(`  Variant ${i + 1}: ${v.title} (SKU: ${v.sku})`);
      });

      // If there's only one variant with title "Default Title", it might be the auto-created one
      // In that case, we should skip creating variants as it's already created
      const skipVariantCreation =
        variants.length === 1 &&
        variants[0].title === "Default Title" &&
        product.options?.length === 1 &&
        product.options[0].name === "Title";

      console.log(`Skip variant creation: ${skipVariantCreation}`);
      console.log(
        `Product options: ${product.options?.map((o) => o.name).join(", ")}`,
      );

      if (!skipVariantCreation) {
        console.log(
          `Updating ${variants.length} variants for product "${product.title}"`,
        );

        // Get the staging variants that were auto-created
        const stagingVariants =
          createdProduct.variants?.edges?.map((e) => e.node) || [];

        console.log(
          `Found ${stagingVariants.length} auto-created variants in staging`,
        );
        stagingVariants.forEach((v, i) => {
          console.log(
            `  Staging variant ${i + 1}: ${v.title} (options: ${v.selectedOptions?.map((o) => `${o.name}:${o.value}`).join(", ")})`,
          );
        });

        // Check if we have the expected number of variants
        if (stagingVariants.length !== variants.length) {
          console.warn(
            `⚠️ Variant count mismatch: expected ${variants.length} but found ${stagingVariants.length} in staging`,
          );

          // Calculate expected combinations
          const expectedCombinations =
            product.options?.reduce((acc, option) => {
              return acc * (option.values?.length || 1);
            }, 1) || 1;

          console.log(
            `Expected combinations based on options: ${expectedCombinations}`,
          );

          // If Shopify didn't create all expected variants, we might need to create them manually
          if (stagingVariants.length < variants.length) {
            console.log(
              `Missing ${variants.length - stagingVariants.length} variants. Attempting to create missing variants...`,
            );
            // TODO: Implement logic to create missing variants
          }
        }

        const variantsResult = await updateProductVariantsInStaging(
          createdProduct.id,
          variants,
          stagingVariants,
          stagingAdmin,
        );

        if (!variantsResult.success) {
          console.error(
            `Failed to update variants for product "${product.title}": ${variantsResult.error}`,
          );

          // If update failed because no matches were found, try creating variants
          if (variantsResult.error?.includes("No matching variants")) {
            console.log(`Attempting to create variants instead...`);

            const createResult = await createProductVariantsInStaging(
              createdProduct.id,
              variants,
              stagingAdmin,
            );

            if (createResult.success) {
              console.log(
                `Successfully created ${createResult.variants?.length || 0} variants`,
              );
              createdProduct.variants = {
                edges: createResult.variants.map((v) => ({ node: v })),
              };
            } else {
              console.error(
                `Also failed to create variants: ${createResult.error}`,
              );
            }
          }
        } else {
          console.log(
            `Successfully updated ${variantsResult.variants?.length || 0} variants`,
          );
          // Update the created product with variant info
          createdProduct.variants = {
            edges: variantsResult.variants.map((v) => ({ node: v })),
          };
        }
      } else {
        console.log(
          `Skipping variant creation for "${product.title}" - using default variant`,
        );
      }
    }

    // Upload images if they exist
    if (product.images?.edges?.length > 0) {
      const images = product.images.edges.map((edge) => edge.node);
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
    if (product.images?.edges?.length > 0) {
      // Check if product already has images in staging
      const existingImageCount = await checkExistingImages(
        updatedProduct.id,
        stagingAdmin,
      );

      if (existingImageCount === 0) {
        const images = product.images.edges.map((edge) => edge.node);
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
      message: "🚀 Starting products sync operation",
      type: "sync_start",
      details: {
        productionStore,
        timestamp: new Date().toISOString(),
        operation: "products_sync",
      },
    });

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
        message: `Processing product: ${product.title}`,
        percentage: progress,
      });

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

          // Sync variant metafields for existing variants
          if (product.variants?.edges && existingProduct.variants?.edges) {
            console.log(
              `Product ${product.title} has ${product.variants.edges.length} production variants and ${existingProduct.variants.edges.length} staging variants`,
            );

            for (const variantEdge of product.variants.edges) {
              const variant = variantEdge.node;
              console.log(
                `Checking variant: ${variant.title} (SKU: ${variant.sku}), has ${variant.metafields?.nodes?.length || 0} metafields`,
              );

              if (variant.metafields?.nodes?.length > 0) {
                // Find corresponding variant in staging (by SKU or title)
                const stagingVariant = existingProduct.variants.edges.find(
                  (sv) =>
                    sv.node.sku === variant.sku ||
                    sv.node.title === variant.title,
                );

                if (stagingVariant) {
                  console.log(
                    `Found matching staging variant: ${stagingVariant.node.title} (ID: ${stagingVariant.node.id})`,
                  );

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
                } else {
                  console.log(
                    `❌ No matching staging variant found for: ${variant.title} (SKU: ${variant.sku})`,
                  );
                }
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
              const createdVariant = result.product.variants.edges[j];

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
