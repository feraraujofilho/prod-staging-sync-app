# Resource Mapping Integration Guide

This guide explains how to integrate the resource mapping system into each sync service **without changing the existing matching logic**.

## Overview

The mapping system tracks the relationship between production and staging resource IDs, enabling proper translation of GID references in metafields. Each resource type uses a different matching strategy that's already working in your sync services.

## Key Principles

1. **DO NOT CHANGE** the existing matching logic
2. **ONLY ADD** mapping storage calls after resources are matched/created
3. **USE** the actual matching keys used in your code (handle, name, filename, etc.)
4. **OPTIONALLY** store the `custom.custom_id` metafield if it exists

## Matching Strategy Reference

| Resource Type | Match Key         | Match Value               | Code Location                    |
| ------------- | ----------------- | ------------------------- | -------------------------------- |
| Products      | `handle`          | Product handle            | `getStagingProductByHandle()`    |
| Variants      | `selectedOptions` | JSON of options           | `toKey(variant)` function        |
| Collections   | `handle`          | Collection handle         | `getStagingCollectionByHandle()` |
| Markets       | `handle`          | Market handle             | Market queries                   |
| Locations     | `name`            | Location name (lowercase) | `matchLocationsByName()`         |
| Pages         | `handle`          | Page handle               | `getStagingPageByHandle()`       |
| Files         | `filename`        | Filename from URL         | `extractFilenameFromUrl()`       |
| Navigation    | `handle`          | Menu handle               | `getStagingMenuByHandle()`       |
| Metaobjects   | `type`            | Metaobject type           | Type comparison                  |

---

## Integration Steps for Each Resource Type

### 1. Products (`sync.products.server.js`)

**Where to integrate**: After a product is created/updated in staging

```javascript
import { saveMapping, extractIdFromGid } from "./resource-mapping.server.js";

// After creating or finding the staging product
// Around line 1900-2000 where you have both production and staging product objects

async function syncProduct(prodProduct, stagingAdmin, storeConnectionId) {
  // ... existing product sync logic ...

  // After you have the staging product (either found or created)
  const stagingProduct = await getStagingProductByHandle(
    prodProduct.handle,
    stagingAdmin,
  );

  if (stagingProduct) {
    // Save the mapping
    try {
      // Extract custom_id if it exists
      const customIdMetafield = prodProduct.metafields?.nodes?.find(
        (m) => m.namespace === "custom" && m.key === "custom_id",
      );

      await saveMapping(storeConnectionId, "product", {
        productionId: extractIdFromGid(prodProduct.id),
        stagingId: extractIdFromGid(stagingProduct.id),
        productionGid: prodProduct.id,
        stagingGid: stagingProduct.id,
        matchKey: "handle",
        matchValue: prodProduct.handle,
        syncId: customIdMetafield?.value || null,
        title: prodProduct.title,
      });

      console.log(`✅ Saved mapping for product: ${prodProduct.handle}`);
    } catch (error) {
      console.error(
        `Failed to save mapping for product ${prodProduct.handle}:`,
        error.message,
      );
      // Don't throw - continue with sync even if mapping fails
    }
  }

  // ... continue with rest of sync logic ...
}
```

### 2. Product Variants (`sync.products.server.js`)

**Where to integrate**: After variants are matched or created

```javascript
// After matching/creating variants (around line 600-750)

for (const prodVariant of productionVariants) {
  // ... existing variant matching logic ...

  if (stagingVariant) {
    // Save the variant mapping
    try {
      const optionsKey = prodVariant.selectedOptions
        .map((o) => `${o.name}:${o.value}`)
        .sort()
        .join("|");

      await saveMapping(storeConnectionId, "variant", {
        productionId: extractIdFromGid(prodVariant.id),
        stagingId: extractIdFromGid(stagingVariant.id),
        productionGid: prodVariant.id,
        stagingGid: stagingVariant.id,
        matchKey: "selectedOptions",
        matchValue: optionsKey,
        syncId: null, // variants typically don't have custom_id
        title: prodVariant.title,
        metadata: { selectedOptions: prodVariant.selectedOptions },
      });

      console.log(`✅ Saved mapping for variant: ${prodVariant.title}`);
    } catch (error) {
      console.error(
        `Failed to save mapping for variant ${prodVariant.title}:`,
        error.message,
      );
    }
  }
}
```

### 3. Collections (`sync.collections.server.js`)

**Where to integrate**: After collection is created/found (around line 646)

```javascript
import { saveMapping, extractIdFromGid } from "./resource-mapping.server.js";

// After finding or creating the staging collection
const existingCollection = await getStagingCollectionByHandle(
  prodCollection.handle,
  stagingAdmin,
);

if (existingCollection) {
  // Save the mapping
  try {
    await saveMapping(storeConnectionId, "collection", {
      productionId: extractIdFromGid(prodCollection.id),
      stagingId: extractIdFromGid(existingCollection.id),
      productionGid: prodCollection.id,
      stagingGid: existingCollection.id,
      matchKey: "handle",
      matchValue: prodCollection.handle,
      syncId: null,
      title: prodCollection.title,
    });

    console.log(`✅ Saved mapping for collection: ${prodCollection.handle}`);
  } catch (error) {
    console.error(
      `Failed to save mapping for collection ${prodCollection.handle}:`,
      error.message,
    );
  }
}
```

### 4. Markets (`sync.markets.server.js`)

**Where to integrate**: After market is created/found

```javascript
import { saveMapping, extractIdFromGid } from "./resource-mapping.server.js";

// After finding or creating the staging market
// Look for where you match markets by handle

const stagingMarket = stagingMarkets.find(
  (sm) => sm.handle === prodMarket.handle,
);

if (stagingMarket) {
  // Save the mapping
  try {
    await saveMapping(storeConnectionId, "market", {
      productionId: extractIdFromGid(prodMarket.id),
      stagingId: extractIdFromGid(stagingMarket.id),
      productionGid: prodMarket.id,
      stagingGid: stagingMarket.id,
      matchKey: "handle",
      matchValue: prodMarket.handle,
      syncId: null,
      title: prodMarket.name,
    });

    console.log(`✅ Saved mapping for market: ${prodMarket.handle}`);
  } catch (error) {
    console.error(
      `Failed to save mapping for market ${prodMarket.handle}:`,
      error.message,
    );
  }
}
```

### 5. Locations (`sync.locations.server.js`)

**Where to integrate**: After locations are matched by name

```javascript
import { saveMapping, extractIdFromGid } from "./resource-mapping.server.js";
import { matchLocationsByName } from "./sync.locations.helper.server.js";

// After matching locations
const locationMap = matchLocationsByName(productionLocations, stagingLocations);

// Save mappings for all matched locations
for (const prodLocation of productionLocations) {
  const stagingLocationId = locationMap.get(prodLocation.id);

  if (stagingLocationId) {
    // Find the staging location object
    const stagingLocation = stagingLocations.find(
      (sl) => sl.id === stagingLocationId,
    );

    if (stagingLocation) {
      try {
        await saveMapping(storeConnectionId, "location", {
          productionId: extractIdFromGid(prodLocation.id),
          stagingId: extractIdFromGid(stagingLocation.id),
          productionGid: prodLocation.id,
          stagingGid: stagingLocation.id,
          matchKey: "name",
          matchValue: prodLocation.name.toLowerCase(), // lowercase for consistency
          syncId: null,
          title: prodLocation.name,
        });

        console.log(`✅ Saved mapping for location: ${prodLocation.name}`);
      } catch (error) {
        console.error(
          `Failed to save mapping for location ${prodLocation.name}:`,
          error.message,
        );
      }
    }
  }
}
```

### 6. Pages (`sync.pages.server.js`)

**Where to integrate**: After page is created/found

```javascript
import { saveMapping, extractIdFromGid } from "./resource-mapping.server.js";

// After finding or creating the staging page
const existingPage = await getStagingPageByHandle(
  prodPage.handle,
  stagingAdmin,
);

if (existingPage) {
  // Save the mapping
  try {
    await saveMapping(storeConnectionId, "page", {
      productionId: extractIdFromGid(prodPage.id),
      stagingId: extractIdFromGid(existingPage.id),
      productionGid: prodPage.id,
      stagingGid: existingPage.id,
      matchKey: "handle",
      matchValue: prodPage.handle,
      syncId: null,
      title: prodPage.title,
    });

    console.log(`✅ Saved mapping for page: ${prodPage.handle}`);
  } catch (error) {
    console.error(
      `Failed to save mapping for page ${prodPage.handle}:`,
      error.message,
    );
  }
}
```

### 7. Files (`sync.files.server.js`)

**Where to integrate**: After file is uploaded to staging

```javascript
import { saveMapping, extractIdFromGid } from "./resource-mapping.server.js";

// After creating file in staging
const result = await createFileInStaging(prodFile, stagingAdmin);

if (result.success && result.file) {
  // Save the mapping
  try {
    const filename = extractFilenameFromUrl(prodFile.image.url);

    await saveMapping(storeConnectionId, "file", {
      productionId: extractIdFromGid(prodFile.id),
      stagingId: extractIdFromGid(result.file.id),
      productionGid: prodFile.id,
      stagingGid: result.file.id,
      matchKey: "filename",
      matchValue: filename,
      syncId: null,
      title: filename,
    });

    console.log(`✅ Saved mapping for file: ${filename}`);
  } catch (error) {
    console.error(
      `Failed to save mapping for file ${filename}:`,
      error.message,
    );
  }
}
```

### 8. Navigation Menus (`sync.navigation.server.js`)

**Where to integrate**: After menu is created/found

```javascript
import { saveMapping, extractIdFromGid } from "./resource-mapping.server.js";

// After finding or creating the staging menu
const existingMenu = await getStagingMenuByHandle(
  prodMenu.handle,
  stagingAdmin,
);

if (existingMenu) {
  // Save the mapping
  try {
    await saveMapping(storeConnectionId, "navigation", {
      productionId: extractIdFromGid(prodMenu.id),
      stagingId: extractIdFromGid(existingMenu.id),
      productionGid: prodMenu.id,
      stagingGid: existingMenu.id,
      matchKey: "handle",
      matchValue: prodMenu.handle,
      syncId: null,
      title: prodMenu.title,
    });

    console.log(`✅ Saved mapping for menu: ${prodMenu.handle}`);
  } catch (error) {
    console.error(
      `Failed to save mapping for menu ${prodMenu.handle}:`,
      error.message,
    );
  }
}
```

### 9. Metaobjects (`sync.metaobjects.server.js`)

**Where to integrate**: After metaobject definition is created/found

```javascript
import { saveMapping, extractIdFromGid } from "./resource-mapping.server.js";

// After finding or creating the staging metaobject definition
const existingDef = stagingDefinitions.find((d) => d.type === prodDef.type);

if (existingDef) {
  // Save the mapping
  try {
    await saveMapping(storeConnectionId, "metaobject", {
      productionId: extractIdFromGid(prodDef.id),
      stagingId: extractIdFromGid(existingDef.id),
      productionGid: prodDef.id,
      stagingGid: existingDef.id,
      matchKey: "type",
      matchValue: prodDef.type,
      syncId: null,
      title: prodDef.name,
    });

    console.log(`✅ Saved mapping for metaobject: ${prodDef.type}`);
  } catch (error) {
    console.error(
      `Failed to save mapping for metaobject ${prodDef.type}:`,
      error.message,
    );
  }
}
```

---

## GID Translation Integration

### When to Translate Metafields

Add GID translation **before** syncing metafield values to staging:

```javascript
import { translateMetafields } from "../utils/gid-translator.server.js";

// Before syncing metafields for any resource
const ownerContext = `${resourceType}:${extractIdFromGid(productionResource.id)}`;
const syncType = "products"; // or 'collections', 'pages', etc.

const translationResult = await translateMetafields(
  storeConnectionId,
  productionResource.metafields?.nodes || [],
  ownerContext,
  syncType,
);

// Use the translated metafields
const metafieldsToSync = translationResult.metafields;

// Log translation stats
console.log(`Translated ${translationResult.stats.translated} GID references`);
console.log(`Found ${translationResult.stats.unmapped} unmapped references`);
console.log(
  `Skipped ${translationResult.stats.skipped} metafields with unmapped references`,
);

// Continue with existing metafield sync logic using metafieldsToSync
```

---

## Testing the Integration

### 1. Run a Sync

After integrating mapping into a sync service:

```bash
# Run the sync from the UI or CLI
npm run dev
```

### 2. Check the Database

```bash
# Open Prisma Studio
npx prisma studio
```

Look for records in the `ResourceMapping` table with:

- Correct `matchKey` values (handle, name, filename, type, selectedOptions)
- Correct `matchValue` values
- Both `productionGid` and `stagingGid` populated

### 3. View in the UI

Navigate to `/app/mapped-elements` to see:

- All mapped resources by type
- The matching keys and values used
- Any unmapped references found during sync

### 4. Test GID Translation

1. Sync products with metafields containing GIDs (like Search & Discovery app data)
2. Check the unmapped references page to see if any GIDs couldn't be mapped
3. If there are unmapped references:
   - Sync the missing resources first
   - Re-sync the resources that contain those references

---

## Troubleshooting

### Issue: Mapping not being created

**Check:**

- Is `storeConnectionId` being passed correctly?
- Are both `productionGid` and `stagingGid` valid?
- Is the `matchKey` and `matchValue` correct?
- Check console for error messages

### Issue: Unmapped references appearing

**Cause:** Resources referenced in metafields haven't been synced yet

**Solution:**

1. Check the "Match Value" in the unmapped references table
2. Sync that resource type first
3. Re-sync the resource containing the references

### Issue: GID translation not working

**Check:**

- Has the mapping been created for the referenced resource?
- Is the GID format correct (`gid://shopify/[Type]/[ID]`)?
- Check the `UnmappedReference` table for details

---

## Best Practices

1. **Always wrap mapping calls in try-catch** - Don't let mapping failures break the sync
2. **Log mapping operations** - Use console.log to track what's being mapped
3. **Pass storeConnectionId consistently** - Get it from the action/loader
4. **Store the actual matching value** - Use the same value you used for matching
5. **Don't change existing matching logic** - Only add mapping storage
6. **Extract custom_id when available** - Check for custom.custom_id metafield on products/collections
7. **Test incrementally** - Add mapping to one sync service at a time

---

## Summary

The mapping system is designed to be added **on top of** your existing sync logic without changing how resources are matched. The key steps are:

1. Import the mapping functions
2. Find where resources are matched/created in your sync service
3. Add a `saveMapping()` call after successful match/creation
4. Use the same matching key/value you use in your existing code
5. Wrap in try-catch to prevent failures from breaking sync
6. Add GID translation before syncing metafields

This approach ensures your working sync logic remains untouched while adding the mapping functionality needed for GID translation.
