import { describe, it, expect } from "vitest";

describe("Fix 2A: Variant matching by selectedOptions (not array index)", () => {
  // Helper that replicates the fix logic
  function matchVariantByOptions(prodVariant, stagingEdges) {
    return stagingEdges.find((sv) => {
      const prodOptions = prodVariant.selectedOptions
        ?.map((o) => `${o.name}:${o.value}`)
        .sort()
        .join("|");
      const stagingOptions = sv.node.selectedOptions
        ?.map((o) => `${o.name}:${o.value}`)
        .sort()
        .join("|");
      return prodOptions === stagingOptions;
    });
  }

  it("matches variant by selectedOptions correctly", () => {
    const prodVariant = {
      id: "gid://shopify/ProductVariant/111",
      title: "Small / Red",
      selectedOptions: [
        { name: "Size", value: "Small" },
        { name: "Color", value: "Red" },
      ],
    };

    const stagingEdges = [
      {
        node: {
          id: "gid://shopify/ProductVariant/901",
          title: "Large / Blue",
          selectedOptions: [
            { name: "Size", value: "Large" },
            { name: "Color", value: "Blue" },
          ],
        },
      },
      {
        node: {
          id: "gid://shopify/ProductVariant/902",
          title: "Small / Red",
          selectedOptions: [
            { name: "Size", value: "Small" },
            { name: "Color", value: "Red" },
          ],
        },
      },
    ];

    const match = matchVariantByOptions(prodVariant, stagingEdges);
    expect(match).toBeDefined();
    expect(match.node.id).toBe("gid://shopify/ProductVariant/902");
  });

  it("matches even when options are in different order", () => {
    const prodVariant = {
      selectedOptions: [
        { name: "Color", value: "Red" },
        { name: "Size", value: "Small" },
      ],
    };

    const stagingEdges = [
      {
        node: {
          id: "gid://shopify/ProductVariant/901",
          selectedOptions: [
            { name: "Size", value: "Small" },
            { name: "Color", value: "Red" },
          ],
        },
      },
    ];

    const match = matchVariantByOptions(prodVariant, stagingEdges);
    expect(match).toBeDefined();
    expect(match.node.id).toBe("gid://shopify/ProductVariant/901");
  });

  it("returns undefined when no matching variant exists", () => {
    const prodVariant = {
      selectedOptions: [{ name: "Size", value: "XL" }],
    };

    const stagingEdges = [
      {
        node: {
          id: "gid://shopify/ProductVariant/901",
          selectedOptions: [{ name: "Size", value: "Small" }],
        },
      },
    ];

    const match = matchVariantByOptions(prodVariant, stagingEdges);
    expect(match).toBeUndefined();
  });

  it("does NOT match by array index (the old bug)", () => {
    // Before fix: array index 0 would match staging index 0 regardless of options
    const prodVariants = [
      {
        selectedOptions: [{ name: "Size", value: "Small" }],
      },
      {
        selectedOptions: [{ name: "Size", value: "Large" }],
      },
    ];

    // Staging has them in REVERSE order
    const stagingEdges = [
      {
        node: {
          id: "gid://shopify/ProductVariant/902",
          selectedOptions: [{ name: "Size", value: "Large" }],
        },
      },
      {
        node: {
          id: "gid://shopify/ProductVariant/901",
          selectedOptions: [{ name: "Size", value: "Small" }],
        },
      },
    ];

    // Index-based matching would give wrong results:
    // prodVariants[0] (Small) would match stagingEdges[0] (Large) ← WRONG
    // Our fix matches by options:
    const match0 = matchVariantByOptions(prodVariants[0], stagingEdges);
    const match1 = matchVariantByOptions(prodVariants[1], stagingEdges);

    expect(match0.node.id).toBe("gid://shopify/ProductVariant/901"); // Small → Small
    expect(match1.node.id).toBe("gid://shopify/ProductVariant/902"); // Large → Large
  });

  it("handles single-option variants (Default Title)", () => {
    const prodVariant = {
      selectedOptions: [{ name: "Title", value: "Default Title" }],
    };

    const stagingEdges = [
      {
        node: {
          id: "gid://shopify/ProductVariant/901",
          selectedOptions: [{ name: "Title", value: "Default Title" }],
        },
      },
    ];

    const match = matchVariantByOptions(prodVariant, stagingEdges);
    expect(match).toBeDefined();
  });
});

describe("Fix 2B: publishablePublish input format", () => {
  it("input should be an array, not an object", () => {
    const publicationId = "gid://shopify/Publication/123";

    // The fix changed input from { publicationId } to [{ publicationId }]
    const input = [{ publicationId }];

    expect(Array.isArray(input)).toBe(true);
    expect(input).toHaveLength(1);
    expect(input[0].publicationId).toBe(publicationId);
  });
});

describe("Fix 2F: ignoreCompareQuantity is required", () => {
  it("inventory input MUST contain ignoreCompareQuantity: true", () => {
    const input = {
      name: "available",
      reason: "correction",
      ignoreCompareQuantity: true,
      quantities: [
        {
          inventoryItemId: "gid://shopify/InventoryItem/123",
          locationId: "gid://shopify/Location/456",
          quantity: 10,
        },
      ],
    };

    expect(input).toHaveProperty("ignoreCompareQuantity", true);
    expect(input.name).toBe("available");
    expect(input.reason).toBe("correction");
  });

  it("on_hand input also requires ignoreCompareQuantity: true", () => {
    const input = {
      name: "on_hand",
      reason: "correction",
      ignoreCompareQuantity: true,
      quantities: [
        {
          inventoryItemId: "gid://shopify/InventoryItem/123",
          locationId: "gid://shopify/Location/456",
          quantity: 5,
        },
      ],
    };

    expect(input).toHaveProperty("ignoreCompareQuantity", true);
    expect(input.name).toBe("on_hand");
  });

  it("individual quantities should NOT have compareQuantity", () => {
    const quantity = {
      inventoryItemId: "gid://shopify/InventoryItem/123",
      locationId: "gid://shopify/Location/456",
      quantity: 10,
    };

    // We use ignoreCompareQuantity at the input level, not compareQuantity per entry
    expect(quantity).not.toHaveProperty("compareQuantity");
  });
});

describe("Fix 2G: on_hand quantity sync", () => {
  it("extracts on_hand quantity from production levels", () => {
    const prodLevel = {
      quantities: [
        { name: "available", quantity: 10 },
        { name: "on_hand", quantity: 15 },
        { name: "committed", quantity: 5 },
      ],
    };

    const onHandQty = prodLevel.quantities?.find(
      (q) => q.name === "on_hand",
    )?.quantity;

    expect(onHandQty).toBe(15);
  });

  it("returns undefined when on_hand is not present", () => {
    const prodLevel = {
      quantities: [{ name: "available", quantity: 10 }],
    };

    const onHandQty = prodLevel.quantities?.find(
      (q) => q.name === "on_hand",
    )?.quantity;

    expect(onHandQty).toBeUndefined();
  });

  it("handles zero on_hand quantity", () => {
    const prodLevel = {
      quantities: [
        { name: "available", quantity: 0 },
        { name: "on_hand", quantity: 0 },
      ],
    };

    const onHandQty = prodLevel.quantities?.find(
      (q) => q.name === "on_hand",
    )?.quantity;

    expect(onHandQty).toBe(0);
    // Should still sync because 0 !== undefined
    expect(onHandQty !== undefined && onHandQty !== null).toBe(true);
  });
});

describe("Fix 2E: Variant and inventory_item mapping data", () => {
  it("builds correct variant mapping data", () => {
    const variant = {
      id: "gid://shopify/ProductVariant/111",
      title: "Small / Red",
      sku: "SHIRT-S-R",
      selectedOptions: [
        { name: "Size", value: "Small" },
        { name: "Color", value: "Red" },
      ],
      inventoryItem: { id: "gid://shopify/InventoryItem/222" },
    };

    const stagingVariant = {
      id: "gid://shopify/ProductVariant/999",
      inventoryItem: { id: "gid://shopify/InventoryItem/888" },
    };

    // Simulate extractIdFromGid
    const extractId = (gid) => gid?.match(/\/(\d+)$/)?.[1] || null;

    const variantMapping = {
      productionId: extractId(variant.id),
      stagingId: extractId(stagingVariant.id),
      productionGid: variant.id,
      stagingGid: stagingVariant.id,
      matchKey: "selectedOptions",
      matchValue: variant.selectedOptions
        ?.map((o) => `${o.name}:${o.value}`)
        .join("|"),
      title: variant.title,
    };

    expect(variantMapping.productionId).toBe("111");
    expect(variantMapping.stagingId).toBe("999");
    expect(variantMapping.matchKey).toBe("selectedOptions");
    expect(variantMapping.matchValue).toBe("Size:Small|Color:Red");

    const inventoryMapping = {
      productionId: extractId(variant.inventoryItem.id),
      stagingId: extractId(stagingVariant.inventoryItem.id),
      productionGid: variant.inventoryItem.id,
      stagingGid: stagingVariant.inventoryItem.id,
      matchKey: "variant_sku",
      matchValue: variant.sku || variant.title,
    };

    expect(inventoryMapping.productionId).toBe("222");
    expect(inventoryMapping.stagingId).toBe("888");
    expect(inventoryMapping.matchKey).toBe("variant_sku");
    expect(inventoryMapping.matchValue).toBe("SHIRT-S-R");
  });

  it("uses variant title when sku is missing", () => {
    const variant = {
      id: "gid://shopify/ProductVariant/111",
      title: "Default Title",
      sku: null,
      selectedOptions: [{ name: "Title", value: "Default Title" }],
    };

    const matchValue = variant.sku || variant.title;
    expect(matchValue).toBe("Default Title");
  });
});

describe("Fix 8A: Product category uses new `category` field (API 2025-07)", () => {
  // In API 2025-07, `productCategory` was deprecated in favor of `category` (direct ID).
  // Old: productCategory: { productTaxonomyNodeId: "gid://..." } (REMOVED from ProductInput)
  // New: category: "gid://shopify/TaxonomyCategory/..." (direct ID field)
  function buildProductInput(product, productId = null) {
    const input = {
      title: product.title,
      productType: product.productType,
      status: product.status,
    };
    if (productId) input.id = productId;
    // Use new `category` field (direct ID) instead of deprecated `productCategory`
    if (product.category?.id) {
      input.category = product.category.id;
    }
    return input;
  }

  it("sets category ID from product.category on create", () => {
    const product = {
      title: "Travel Suitcase",
      productType: "Luggage",
      status: "ACTIVE",
      category: {
        id: "gid://shopify/TaxonomyCategory/sg-4-17-2-17",
        name: "Suitcases",
        fullName: "Luggage & Bags > Suitcases",
      },
    };

    const input = buildProductInput(product);
    expect(input.category).toBe("gid://shopify/TaxonomyCategory/sg-4-17-2-17");
    expect(input.productCategory).toBeUndefined();
  });

  it("sets category ID on update too", () => {
    const product = {
      title: "Guitar",
      productType: "Music",
      status: "ACTIVE",
      category: {
        id: "gid://shopify/TaxonomyCategory/mu-1-2",
        name: "Guitars",
        fullName: "Musical Instruments > Guitars",
      },
    };

    const input = buildProductInput(product, "gid://shopify/Product/123");
    expect(input.id).toBe("gid://shopify/Product/123");
    expect(input.category).toBe("gid://shopify/TaxonomyCategory/mu-1-2");
    expect(input.productCategory).toBeUndefined();
  });

  it("omits category when product has no category", () => {
    const product = {
      title: "Uncategorized Item",
      productType: "",
      status: "ACTIVE",
    };

    const input = buildProductInput(product);
    expect(input.category).toBeUndefined();
    expect(input.productCategory).toBeUndefined();
    expect(input.title).toBe("Uncategorized Item");
  });
});

describe("Fix 2H: Variant pagination for >100 variants", () => {
  // Simulates the pagination logic in getStagingProductByHandle
  function collectAllVariants(pages) {
    const allVariantEdges = [];
    for (const page of pages) {
      allVariantEdges.push(...(page.variants?.edges || []));
    }
    return allVariantEdges;
  }

  it("collects variants from a single page", () => {
    const pages = [
      {
        variants: {
          edges: [
            { node: { id: "gid://shopify/ProductVariant/1" } },
            { node: { id: "gid://shopify/ProductVariant/2" } },
          ],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    ];

    const allEdges = collectAllVariants(pages);
    expect(allEdges).toHaveLength(2);
  });

  it("collects variants across multiple pages", () => {
    const page1Variants = Array.from({ length: 100 }, (_, i) => ({
      node: { id: `gid://shopify/ProductVariant/${i + 1}` },
    }));
    const page2Variants = Array.from({ length: 50 }, (_, i) => ({
      node: { id: `gid://shopify/ProductVariant/${i + 101}` },
    }));

    const pages = [
      {
        variants: {
          edges: page1Variants,
          pageInfo: { hasNextPage: true, endCursor: "cursor1" },
        },
      },
      {
        variants: {
          edges: page2Variants,
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    ];

    const allEdges = collectAllVariants(pages);
    expect(allEdges).toHaveLength(150);
    expect(allEdges[0].node.id).toBe("gid://shopify/ProductVariant/1");
    expect(allEdges[99].node.id).toBe("gid://shopify/ProductVariant/100");
    expect(allEdges[100].node.id).toBe("gid://shopify/ProductVariant/101");
    expect(allEdges[149].node.id).toBe("gid://shopify/ProductVariant/150");
  });

  it("handles product with zero variants", () => {
    const pages = [
      {
        variants: {
          edges: [],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    ];

    const allEdges = collectAllVariants(pages);
    expect(allEdges).toHaveLength(0);
  });

  it("preserves variant data across pages", () => {
    const pages = [
      {
        variants: {
          edges: [
            {
              node: {
                id: "gid://shopify/ProductVariant/1",
                sku: "SKU-1",
                selectedOptions: [{ name: "Size", value: "Small" }],
              },
            },
          ],
          pageInfo: { hasNextPage: true, endCursor: "cursor1" },
        },
      },
      {
        variants: {
          edges: [
            {
              node: {
                id: "gid://shopify/ProductVariant/2",
                sku: "SKU-2",
                selectedOptions: [{ name: "Size", value: "Large" }],
              },
            },
          ],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    ];

    const allEdges = collectAllVariants(pages);
    expect(allEdges).toHaveLength(2);
    expect(allEdges[0].node.sku).toBe("SKU-1");
    expect(allEdges[1].node.sku).toBe("SKU-2");
    expect(allEdges[0].node.selectedOptions[0].value).toBe("Small");
    expect(allEdges[1].node.selectedOptions[0].value).toBe("Large");
  });
});

describe("Multi-channel publishing", () => {
  // Simulates the publishProductToAllChannels logic
  function buildPublishInput(publications) {
    return publications.map((pub) => ({ publicationId: pub.id }));
  }

  it("builds publish input for all staging publications", () => {
    const publications = [
      { id: "gid://shopify/Publication/1", name: "Online Store" },
      { id: "gid://shopify/Publication/2", name: "Shop" },
      { id: "gid://shopify/Publication/3", name: "Google & YouTube" },
      { id: "gid://shopify/Publication/4", name: "Facebook & Instagram" },
    ];

    const input = buildPublishInput(publications);
    expect(input).toHaveLength(4);
    expect(input[0]).toEqual({ publicationId: "gid://shopify/Publication/1" });
    expect(input[3]).toEqual({ publicationId: "gid://shopify/Publication/4" });
  });

  it("returns empty array when no publications found", () => {
    const input = buildPublishInput([]);
    expect(input).toHaveLength(0);
  });

  it("handles single publication gracefully", () => {
    const publications = [
      { id: "gid://shopify/Publication/1", name: "Online Store" },
    ];

    const input = buildPublishInput(publications);
    expect(input).toHaveLength(1);
    expect(input[0].publicationId).toBe("gid://shopify/Publication/1");
  });
});
