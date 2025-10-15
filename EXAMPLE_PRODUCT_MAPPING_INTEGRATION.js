/**
 * EXAMPLE: Product Sync with Mapping Integration
 *
 * This file shows exactly where and how to add mapping calls to sync.products.server.js
 * WITHOUT changing the existing matching logic.
 *
 * SEARCH FOR THESE MARKERS IN YOUR sync.products.server.js:
 * - [MAPPING_POINT_1] - Import the mapping functions
 * - [MAPPING_POINT_2] - Save product mapping
 * - [MAPPING_POINT_3] - Save variant mappings
 * - [MAPPING_POINT_4] - Translate metafields before syncing
 */

// ============================================================================
// [MAPPING_POINT_1]: Add these imports at the top of sync.products.server.js
// ============================================================================

import { saveMapping, extractIdFromGid } from "./resource-mapping.server.js";
import { translateMetafields } from "../utils/gid-translator.server.js";

// ============================================================================
// [MAPPING_POINT_2]: Save Product Mapping
// Location: After you have both production and staging product objects
// Around line 1900-2000 in the main sync loop
// ============================================================================

/**
 * Example of where to add in your syncProducts function:
 */

export async function syncProducts(
  productionStore,
  accessToken,
  stagingAdmin,
  onProgress,
) {
  // ... existing code to get storeConnectionId ...
  // This should come from your action/loader context
  const { session } = await authenticate.admin(request);
  const connection = await prisma.storeConnection.findFirst({
    where: { shop: session.shop, isActive: true },
  });
  const storeConnectionId = connection?.id;

  // ... existing code to fetch production products ...
  const productionProducts = await getProductionProducts(
    productionStore,
    accessToken,
  );

  for (const prodProduct of productionProducts) {
    try {
      console.log(`\n📦 Syncing product: ${prodProduct.title}`);

      // === EXISTING CODE: Check if product exists in staging ===
      const existingProduct = await getStagingProductByHandle(
        prodProduct.handle,
        stagingAdmin,
      );

      let stagingProduct;

      if (existingProduct) {
        console.log(`Product exists in staging: ${existingProduct.id}`);
        stagingProduct = existingProduct;
        // ... existing update logic ...
      } else {
        console.log(`Creating new product in staging`);
        // ... existing create logic ...
        stagingProduct = createdProduct;
      }

      // =========================================================================
      // 🆕 NEW: Save the mapping (ADD THIS BLOCK)
      // =========================================================================
      if (stagingProduct && storeConnectionId) {
        try {
          // Extract custom_id metafield if it exists
          const customIdMetafield = prodProduct.metafields?.nodes?.find(
            (m) => m.namespace === "custom" && m.key === "custom_id",
          );

          await saveMapping(storeConnectionId, "product", {
            productionId: extractIdFromGid(prodProduct.id),
            stagingId: extractIdFromGid(stagingProduct.id),
            productionGid: prodProduct.id,
            stagingGid: stagingProduct.id,
            matchKey: "handle", // ⭐ This is what you use for matching!
            matchValue: prodProduct.handle, // ⭐ The actual handle value
            syncId: customIdMetafield?.value || null,
            title: prodProduct.title,
          });

          console.log(
            `✅ Saved mapping: ${prodProduct.handle} (${extractIdFromGid(prodProduct.id)} → ${extractIdFromGid(stagingProduct.id)})`,
          );
        } catch (mappingError) {
          console.error(
            `⚠️ Failed to save mapping for product ${prodProduct.handle}:`,
            mappingError.message,
          );
          // Don't throw - continue with sync even if mapping fails
        }
      }
      // =========================================================================

      // ... continue with existing variant sync, image sync, etc. ...
    } catch (error) {
      console.error(`Error syncing product ${prodProduct.title}:`, error);
      // ... existing error handling ...
    }
  }
}

// ============================================================================
// [MAPPING_POINT_3]: Save Variant Mappings
// Location: Inside the variant matching loop
// Around line 600-750 where variants are matched by selectedOptions
// ============================================================================

/**
 * Example of where to add in your syncVariants/updateVariants function:
 */

async function updateProductVariants(
  productId,
  productionVariants,
  stagingVariants,
  stagingAdmin,
  storeConnectionId, // ⭐ Pass this parameter
) {
  // ... existing variant matching logic ...

  // Helper to create option key (ALREADY IN YOUR CODE)
  const toKey = (v) =>
    v.selectedOptions
      .map((o) => `${o.name}:${o.value}`)
      .sort()
      .join("|");

  for (const prodVariant of productionVariants) {
    console.log(`\nMatching production variant: ${prodVariant.title}`);

    // === EXISTING CODE: Find matching staging variant ===
    const stagingVariant = stagingVariants.find((sv) => {
      if (!sv.selectedOptions || sv.selectedOptions.length === 0) {
        return false;
      }

      const matches = prodVariant.selectedOptions.every((prodOption) => {
        const stagingOption = sv.selectedOptions.find(
          (so) => so.name === prodOption.name,
        );
        return stagingOption && stagingOption.value === prodOption.value;
      });

      return matches;
    });

    if (stagingVariant) {
      console.log(`✅ Found match: staging variant ${stagingVariant.id}`);

      // ... existing variant update logic ...

      // =========================================================================
      // 🆕 NEW: Save the variant mapping (ADD THIS BLOCK)
      // =========================================================================
      if (storeConnectionId) {
        try {
          const optionsKey = toKey(prodVariant); // Use your existing function

          await saveMapping(storeConnectionId, "variant", {
            productionId: extractIdFromGid(prodVariant.id),
            stagingId: extractIdFromGid(stagingVariant.id),
            productionGid: prodVariant.id,
            stagingGid: stagingVariant.id,
            matchKey: "selectedOptions", // ⭐ This is what you use for matching!
            matchValue: optionsKey, // ⭐ The options combination
            syncId: null, // Variants typically don't have custom_id
            title: prodVariant.title,
            metadata: {
              selectedOptions: prodVariant.selectedOptions,
            },
          });

          console.log(
            `✅ Saved mapping for variant: ${prodVariant.title} (${optionsKey})`,
          );
        } catch (mappingError) {
          console.error(
            `⚠️ Failed to save mapping for variant ${prodVariant.title}:`,
            mappingError.message,
          );
          // Don't throw - continue with sync
        }
      }
      // =========================================================================
    } else {
      console.warn(
        `❌ No matching staging variant found for: ${prodVariant.title}`,
      );
      // ... existing logic for creating missing variants ...
    }
  }
}

// ============================================================================
// [MAPPING_POINT_4]: Translate Metafields Before Syncing
// Location: Before calling syncMetafieldValues
// Around where you prepare metafields to sync to staging
// ============================================================================

/**
 * Example of where to add GID translation:
 */

async function syncProductMetafields(
  prodProduct,
  stagingProduct,
  stagingAdmin,
  storeConnectionId,
) {
  const productionMetafields = prodProduct.metafields?.nodes || [];

  if (productionMetafields.length === 0) {
    console.log("No metafields to sync");
    return;
  }

  // =========================================================================
  // 🆕 NEW: Translate GIDs in metafield values (ADD THIS BLOCK)
  // =========================================================================
  console.log(
    `\n🔄 Translating GIDs in ${productionMetafields.length} metafields...`,
  );

  const ownerContext = `product:${extractIdFromGid(prodProduct.id)}`;
  const translationResult = await translateMetafields(
    storeConnectionId,
    productionMetafields,
    ownerContext,
    "products", // Current sync type
  );

  // Log what happened
  console.log(
    `✅ Translated ${translationResult.stats.translated} GID references`,
  );
  if (translationResult.stats.unmapped > 0) {
    console.warn(
      `⚠️ Found ${translationResult.stats.unmapped} unmapped GID references`,
    );
  }
  if (translationResult.stats.skipped > 0) {
    console.warn(
      `⚠️ Skipped ${translationResult.stats.skipped} metafields with unmapped references`,
    );
  }

  // Use the translated metafields
  const metafieldsToSync = translationResult.metafields;
  // =========================================================================

  // === EXISTING CODE: Sync metafields to staging ===
  // Use metafieldsToSync instead of productionMetafields
  await syncMetafieldValues(
    stagingProduct.id,
    "PRODUCT",
    metafieldsToSync, // ⭐ Use translated metafields
    stagingAdmin,
  );

  console.log(`✅ Synced ${metafieldsToSync.length} metafields`);
}

// ============================================================================
// COMPLETE EXAMPLE: Putting It All Together
// ============================================================================

/**
 * This is how your main sync function would look with all mapping integrated:
 */

export async function syncProductsWithMapping(
  productionStore,
  accessToken,
  stagingAdmin,
  onProgress,
) {
  // Get store connection ID (from your context)
  const connection = await prisma.storeConnection.findFirst({
    where: { shop: session.shop, isActive: true },
  });
  const storeConnectionId = connection?.id;

  if (!storeConnectionId) {
    throw new Error("Store connection not found");
  }

  const productionProducts = await getProductionProducts(
    productionStore,
    accessToken,
  );
  const summary = { total: productionProducts.length, created: 0, updated: 0 };

  for (const prodProduct of productionProducts) {
    try {
      // 1. EXISTING: Find or create product in staging
      let stagingProduct = await getStagingProductByHandle(
        prodProduct.handle,
        stagingAdmin,
      );

      if (!stagingProduct) {
        stagingProduct = await createProductInStaging(
          prodProduct,
          stagingAdmin,
        );
        summary.created++;
      } else {
        await updateProductInStaging(prodProduct, stagingProduct, stagingAdmin);
        summary.updated++;
      }

      // 2. NEW: Save product mapping
      await saveMapping(storeConnectionId, "product", {
        productionId: extractIdFromGid(prodProduct.id),
        stagingId: extractIdFromGid(stagingProduct.id),
        productionGid: prodProduct.id,
        stagingGid: stagingProduct.id,
        matchKey: "handle",
        matchValue: prodProduct.handle,
        syncId:
          prodProduct.metafields?.nodes?.find(
            (m) => m.namespace === "custom" && m.key === "custom_id",
          )?.value || null,
        title: prodProduct.title,
      });

      // 3. EXISTING + NEW: Sync variants with mapping
      await syncVariantsWithMapping(
        prodProduct,
        stagingProduct,
        stagingAdmin,
        storeConnectionId,
      );

      // 4. NEW + EXISTING: Translate and sync metafields
      const translatedMetafields = await translateMetafields(
        storeConnectionId,
        prodProduct.metafields?.nodes || [],
        `product:${extractIdFromGid(prodProduct.id)}`,
        "products",
      );

      await syncMetafieldValues(
        stagingProduct.id,
        "PRODUCT",
        translatedMetafields.metafields,
        stagingAdmin,
      );

      console.log(`✅ Successfully synced product: ${prodProduct.title}`);
    } catch (error) {
      console.error(`❌ Error syncing product ${prodProduct.title}:`, error);
      // ... error handling ...
    }
  }

  return { success: true, summary };
}

// ============================================================================
// KEY TAKEAWAYS
// ============================================================================

/**
 * 1. IMPORT at the top:
 *    - saveMapping, extractIdFromGid from resource-mapping.server.js
 *    - translateMetafields from gid-translator.server.js
 *
 * 2. PASS storeConnectionId through your functions
 *    - Get it from your loader/action context
 *    - Pass it down to all sync functions that need mapping
 *
 * 3. SAVE MAPPING after matching/creating resources
 *    - Wrap in try-catch so failures don't break sync
 *    - Use the ACTUAL matchKey and matchValue from your code
 *    - Extract custom_id metafield if it exists
 *
 * 4. TRANSLATE METAFIELDS before syncing them
 *    - Call translateMetafields() before syncMetafieldValues()
 *    - Pass the owner context and sync type
 *    - Use the translated metafields for syncing
 *
 * 5. LOG EVERYTHING
 *    - Use console.log to track what's being mapped
 *    - Log translation statistics
 *    - Make debugging easier
 *
 * 6. HANDLE ERRORS GRACEFULLY
 *    - Don't let mapping failures break your sync
 *    - Log errors but continue processing
 *    - Merchants can review unmapped references in the UI
 */
