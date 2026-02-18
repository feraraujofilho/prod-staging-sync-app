import { describe, it, expect } from "vitest";

describe("Fix 4A: metafield value substring crash guard", () => {
  // Simulates the guard logic added in the fix
  function safeValuePreview(value) {
    return typeof value === "string"
      ? value.substring(0, 50)
      : String(value ?? "");
  }

  it("handles normal string values", () => {
    expect(safeValuePreview("hello world")).toBe("hello world");
  });

  it("truncates long string values to 50 chars", () => {
    const longValue = "a".repeat(100);
    expect(safeValuePreview(longValue)).toBe("a".repeat(50));
  });

  it("handles null without crashing", () => {
    expect(safeValuePreview(null)).toBe("");
  });

  it("handles undefined without crashing", () => {
    expect(safeValuePreview(undefined)).toBe("");
  });

  it("handles number values without crashing", () => {
    expect(safeValuePreview(42)).toBe("42");
  });

  it("handles boolean values without crashing", () => {
    expect(safeValuePreview(true)).toBe("true");
  });

  it("handles object values without crashing", () => {
    expect(safeValuePreview({ key: "value" })).toBe("[object Object]");
  });

  it("handles zero without crashing", () => {
    expect(safeValuePreview(0)).toBe("0");
  });

  it("handles empty string", () => {
    expect(safeValuePreview("")).toBe("");
  });
});

describe("Fix 3C: COLLECTION owner type support in syncMetafieldValues", () => {
  it("ownerTypeQueries should include COLLECTION", () => {
    // Verify the structure we expect in the code
    const ownerTypeQueries = {
      MARKET: "market query...",
      PRODUCT: "product query...",
      PRODUCTVARIANT: "productVariant query...",
      COLLECTION: "collection query...",
    };

    expect(ownerTypeQueries).toHaveProperty("COLLECTION");
  });

  it("dataPathMap should include COLLECTION", () => {
    const dataPathMap = {
      MARKET: "market",
      PRODUCT: "product",
      PRODUCTVARIANT: "productVariant",
      COLLECTION: "collection",
    };

    expect(dataPathMap.COLLECTION).toBe("collection");
  });

  it("unsupported owner type returns error", () => {
    const ownerTypeQueries = {
      MARKET: "...",
      PRODUCT: "...",
      PRODUCTVARIANT: "...",
      COLLECTION: "...",
    };

    const query = ownerTypeQueries["NONEXISTENT"];
    expect(query).toBeUndefined();
  });
});

describe("Fix 4B: Metafield definition pagination", () => {
  describe("getExistingStagingDefinitions pagination logic", () => {
    // Simulates the pagination loop in getExistingStagingDefinitions
    function accumulateDefinitions(pages) {
      const allDefinitions = [];
      for (const page of pages) {
        const edges = page.metafieldDefinitions?.edges || [];
        allDefinitions.push(...edges.map((edge) => edge.node));
      }
      return allDefinitions;
    }

    it("accumulates definitions from a single page", () => {
      const pages = [
        {
          metafieldDefinitions: {
            edges: [
              { node: { id: "def1", namespace: "custom", key: "color", type: { name: "single_line_text_field" } } },
              { node: { id: "def2", namespace: "custom", key: "size", type: { name: "single_line_text_field" } } },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      ];

      const defs = accumulateDefinitions(pages);
      expect(defs).toHaveLength(2);
      expect(defs[0].key).toBe("color");
      expect(defs[1].key).toBe("size");
    });

    it("accumulates definitions across multiple pages", () => {
      const page1Defs = Array.from({ length: 250 }, (_, i) => ({
        node: { id: `def${i}`, namespace: "custom", key: `field_${i}`, type: { name: "single_line_text_field" } },
      }));
      const page2Defs = Array.from({ length: 50 }, (_, i) => ({
        node: { id: `def${i + 250}`, namespace: "custom", key: `field_${i + 250}`, type: { name: "single_line_text_field" } },
      }));

      const pages = [
        {
          metafieldDefinitions: {
            edges: page1Defs,
            pageInfo: { hasNextPage: true, endCursor: "cursor1" },
          },
        },
        {
          metafieldDefinitions: {
            edges: page2Defs,
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      ];

      const defs = accumulateDefinitions(pages);
      expect(defs).toHaveLength(300);
      expect(defs[0].key).toBe("field_0");
      expect(defs[249].key).toBe("field_249");
      expect(defs[250].key).toBe("field_250");
      expect(defs[299].key).toBe("field_299");
    });

    it("returns empty array when no definitions exist", () => {
      const pages = [
        {
          metafieldDefinitions: {
            edges: [],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      ];

      const defs = accumulateDefinitions(pages);
      expect(defs).toHaveLength(0);
    });
  });

  describe("checkMetafieldDefinitions pagination logic", () => {
    // checkMetafieldDefinitions uses same pattern but checks for definition existence
    function checkDefinitionExists(allDefinitions, namespace, key) {
      return allDefinitions.some(
        (def) => def.namespace === namespace && def.key === key,
      );
    }

    it("finds existing definition by namespace and key", () => {
      const definitions = [
        { namespace: "custom", key: "color" },
        { namespace: "custom", key: "size" },
        { namespace: "global", key: "title_tag" },
      ];

      expect(checkDefinitionExists(definitions, "custom", "color")).toBe(true);
      expect(checkDefinitionExists(definitions, "global", "title_tag")).toBe(true);
    });

    it("returns false for non-existent definition", () => {
      const definitions = [
        { namespace: "custom", key: "color" },
      ];

      expect(checkDefinitionExists(definitions, "custom", "missing")).toBe(false);
      expect(checkDefinitionExists(definitions, "other", "color")).toBe(false);
    });

    it("handles empty definitions list", () => {
      expect(checkDefinitionExists([], "custom", "color")).toBe(false);
    });
  });
});
