# Resource Mapping System - Implementation Summary

## 🎯 Overview

A complete resource mapping database system has been designed for your staging store sync app. This system tracks production → staging ID relationships and enables automatic translation of Shopify GIDs in metafield values.

## 📦 What's Been Created

### 1. Database Schema (`prisma/schema.prisma`)

**Two new models added:**

#### `ResourceMapping`

Tracks the relationship between production and staging resource IDs.

**Key fields:**

- `productionId` / `stagingId` - Numeric IDs from both stores
- `productionGid` / `stagingGid` - Full Shopify GIDs
- `matchKey` - The field used for matching (handle, name, filename, type, selectedOptions)
- `matchValue` - The actual value used for matching
- `syncId` - Optional custom.custom_id metafield value
- `title` - Resource title for display
- `metadata` - JSON for additional data (e.g., variant options)

#### `UnmappedReference`

Tracks GID references that couldn't be mapped during sync.

**Key fields:**

- `productionGid` - The GID that couldn't be mapped
- `context` - Where it was found
- `foundInSyncType` - Which sync discovered it
- `resolved` - Whether it's been resolved

### 2. Mapping Service (`app/services/resource-mapping.server.js`)

**Core functions:**

- `saveMapping()` - Save a single mapping
- `saveMappings()` - Batch save multiple mappings
- `getMappingByProductionGid()` - Look up by production GID
- `getMappings()` - Get all mappings for a resource type
- `logUnmappedReference()` - Track unmapped GIDs
- `getUnmappedReferences()` - Get all unmapped references
- `getMappingStats()` - Get statistics by connection

**Helper functions:**

- `extractIdFromGid()` - Extract numeric ID from GID
- `extractResourceTypeFromGid()` - Get resource type from GID
- `normalizeResourceType()` - Convert GID type to database format

### 3. GID Translation Utility (`app/utils/gid-translator.server.js`)

**Translation functions:**

- `translateGid()` - Translate a single GID
- `translateGidsInString()` - Translate all GIDs in a string
- `translateGidsInArray()` - Translate GIDs in an array
- `translateGidsInObject()` - Recursively translate in JSON objects
- `translateMetafieldValue()` - Handle different metafield types
- `translateMetafields()` - Batch translate multiple metafields

**Supported metafield types:**

- `single_line_text_field`
- `multi_line_text_field`
- `url`
- `list.single_line_text_field`
- `json`

**Smart handling:**

- Automatically skips metafields with unmapped references (prevents broken links)
- Logs unmapped references for later resolution
- Provides detailed statistics (translated, unmapped, skipped)

### 4. UI Interface (`app/routes/app.mapped-elements.jsx`)

**Features:**

- View mappings by resource type (tabbed interface)
- Search by ID, match key, match value, title, or sync ID
- Pagination for large datasets
- Shows matching strategy documentation
- Statistics overview (total mappings, unmapped references)
- Direct link to unmapped references page

**Resource types supported:**

- Products
- Product Variants
- Collections
- Markets
- Locations
- Pages
- Files
- Metaobjects
- Navigation Menus

### 5. Unmapped References View (`app/routes/app.mapped-elements.unmapped.jsx`)

**Features:**

- List all unmapped GID references
- Filter by resource type
- Shows context (where the reference was found)
- Displays which sync type discovered it
- Help documentation for resolving unmapped references
- Direct link to Data Sync page

## 🔑 Matching Strategy (Preserved from Existing Code)

| Resource Type | Match Key         | Match Value Example            |
| ------------- | ----------------- | ------------------------------ |
| Products      | `handle`          | `"my-product-handle"`          |
| Variants      | `selectedOptions` | `"Color:Red\|Size:Large"`      |
| Collections   | `handle`          | `"featured-products"`          |
| Markets       | `handle`          | `"international"`              |
| Locations     | `name`            | `"main warehouse"` (lowercase) |
| Pages         | `handle`          | `"about-us"`                   |
| Files         | `filename`        | `"logo.png"`                   |
| Navigation    | `handle`          | `"main-menu"`                  |
| Metaobjects   | `type`            | `"custom_page_sections"`       |

## 🚀 Next Steps

### 1. Run Database Migration

```bash
cd shopify-store-sync
npx prisma migrate dev --name add_resource_mapping_system
```

This will:

- Create the new database tables
- Generate Prisma client with new models
- Apply the migration to your development database

### 2. Integrate Mapping into Sync Services

Follow the comprehensive guide in `MAPPING_INTEGRATION_GUIDE.md` to add mapping storage to each sync service.

**Key points:**

- ✅ DON'T change existing matching logic (it's working!)
- ✅ ONLY add `saveMapping()` calls after resources are matched
- ✅ Use the actual matching key/value from your code
- ✅ Wrap in try-catch to prevent failures
- ✅ Add GID translation before syncing metafields

### 3. Test the System

1. **Run a sync** (e.g., products sync)
2. **Check the database** using Prisma Studio: `npx prisma studio`
3. **View mappings** at `/app/mapped-elements`
4. **Check for unmapped references** at `/app/mapped-elements/unmapped`

### 4. Sync Order for Dependencies

To minimize unmapped references, sync in this order:

1. **Metaobject Definitions** (if used)
2. **Locations** (for inventory references)
3. **Files** (for image references)
4. **Products** (may reference files, metaobjects)
5. **Collections** (references products)
6. **Pages** (may reference products, collections)
7. **Markets** (references products)
8. **Navigation** (references pages, collections, products)

## 💡 How It Solves Your Use Case

### Problem

Search & Discovery app creates metafields with product GIDs:

```json
{
  "custom.related_products": "[\"gid://shopify/Product/10531409363208\"]"
}
```

When synced to staging, these products don't exist with the same IDs.

### Solution

1. **During Product Sync:**
   - Product matched by handle: `"my-product"`
   - Production ID: `10531409363208`
   - Staging ID: `8765432109876`
   - Mapping saved: `10531409363208 → 8765432109876`

2. **During Metafield Sync:**
   - Detect GID in metafield value
   - Look up mapping: `10531409363208 → 8765432109876`
   - Translate: `gid://shopify/Product/10531409363208` → `gid://shopify/Product/8765432109876`
   - Sync translated value to staging

3. **If Unmapped:**
   - Log to `UnmappedReference` table
   - Skip the metafield (prevent broken link)
   - Merchant can view in UI and resolve

## 📊 Database Structure

```
StoreConnection (existing)
├── ResourceMapping (many)
│   ├── productionId + stagingId
│   ├── matchKey + matchValue (how it was matched)
│   ├── syncId (optional custom.custom_id)
│   └── metadata (JSON for extra data)
│
└── UnmappedReference (many)
    ├── productionGid (couldn't be mapped)
    ├── context (where found)
    ├── foundInSyncType (which sync)
    └── resolved (boolean)
```

## 🎨 UI Screenshots (What Merchants Will See)

### Mapped Elements Page

- **Tabs:** Select resource type (Products, Collections, Markets, etc.)
- **Table:** Production ID | Staging ID | Match Key | Match Value | Title | Sync ID | Last Synced
- **Search:** Filter by any field
- **Stats:** Total mappings, unmapped references count
- **Info Card:** Shows matching strategy for each resource type

### Unmapped References Page

- **Table:** Type | Production GID | Production ID | Found In | Sync Type | Date
- **Filter:** By resource type
- **Help:** Instructions on how to resolve
- **Link:** Direct to Data Sync page

## 🔒 Important Notes

1. **No Breaking Changes:** Existing sync logic remains unchanged
2. **Graceful Degradation:** Mapping failures won't break syncs
3. **Optional Sync ID:** The `custom.custom_id` metafield is optional
4. **Match Keys:** Uses the ACTUAL matching strategy from your code
5. **GID Translation:** Happens automatically when configured
6. **Unmapped Handling:** Skips metafields with broken references

## 📚 Files Modified/Created

### Modified:

- `prisma/schema.prisma` - Added ResourceMapping and UnmappedReference models

### Created:

- `app/services/resource-mapping.server.js` - Core mapping service
- `app/utils/gid-translator.server.js` - GID translation utilities
- `app/routes/app.mapped-elements.jsx` - Main UI for viewing mappings
- `app/routes/app.mapped-elements.unmapped.jsx` - Unmapped references UI
- `MAPPING_INTEGRATION_GUIDE.md` - Step-by-step integration guide
- `MAPPING_SYSTEM_SUMMARY.md` - This document

## 🆘 Support

### Common Issues

**Mapping not created:**

- Check `storeConnectionId` is valid
- Verify `matchKey` and `matchValue` are set
- Check console for errors

**Unmapped references:**

- Sync missing resources first
- Re-sync resources with references

**GID translation not working:**

- Verify mapping exists
- Check GID format
- Review `UnmappedReference` table

### Resources

- Integration Guide: `MAPPING_INTEGRATION_GUIDE.md`
- Prisma Docs: https://www.prisma.io/docs
- Shopify GID Format: `gid://shopify/[ResourceType]/[NumericID]`

---

## ✅ Summary Checklist

- [x] Database schema designed with correct matching keys
- [x] Mapping service created with all CRUD operations
- [x] GID translation utility with smart handling
- [x] UI interface for viewing mappings
- [x] Unmapped references tracking and viewing
- [x] Integration guide created
- [ ] Database migration run
- [ ] Mapping integrated into sync services
- [ ] GID translation added to metafield syncs
- [ ] System tested end-to-end

---

**Ready to deploy!** Follow the Next Steps section to complete the implementation.
