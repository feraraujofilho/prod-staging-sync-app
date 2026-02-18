import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  containsGids,
  extractGids,
  translateGidsInString,
  translateGidsInArray,
  translateGidsInObject,
  translateMetafieldValue,
  translateMetafields,
} from "../gid-translator.server.js";

// Mock the resource-mapping module
vi.mock("../../services/resource-mapping.server.js", () => ({
  getMappingByProductionGid: vi.fn(),
  logUnmappedReference: vi.fn().mockResolvedValue(null),
  extractResourceTypeFromGid: vi.fn((gid) => {
    const match = gid?.match(/gid:\/\/shopify\/([^/]+)\/\d+/);
    return match ? match[1] : null;
  }),
}));

import { getMappingByProductionGid } from "../../services/resource-mapping.server.js";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("containsGids", () => {
  it("returns true for strings containing GIDs", () => {
    expect(containsGids("gid://shopify/Product/123")).toBe(true);
  });

  it("returns false for strings without GIDs", () => {
    expect(containsGids("just a regular string")).toBe(false);
  });

  it("returns false for non-strings", () => {
    expect(containsGids(null)).toBe(false);
    expect(containsGids(123)).toBe(false);
    expect(containsGids(undefined)).toBe(false);
  });

  it("does NOT alternate true/false due to regex lastIndex bug (fix 1C)", () => {
    // This was the critical bug: module-level /g regex with .test() mutates lastIndex
    // so calling containsGids twice on the same string would alternate true/false
    const gid = "gid://shopify/Product/123";
    expect(containsGids(gid)).toBe(true);
    expect(containsGids(gid)).toBe(true);
    expect(containsGids(gid)).toBe(true);
    expect(containsGids(gid)).toBe(true);
  });
});

describe("extractGids", () => {
  it("extracts all GIDs from a string", () => {
    const str = 'refs: gid://shopify/Product/111 and gid://shopify/Collection/222';
    const gids = extractGids(str);
    expect(gids).toEqual([
      "gid://shopify/Product/111",
      "gid://shopify/Collection/222",
    ]);
  });

  it("returns empty array for non-strings", () => {
    expect(extractGids(null)).toEqual([]);
    expect(extractGids(123)).toEqual([]);
  });
});

describe("translateGidsInString", () => {
  it("translates mapped GIDs", async () => {
    getMappingByProductionGid.mockResolvedValue({
      stagingGid: "gid://shopify/Product/999",
      resourceType: "product",
    });

    const result = await translateGidsInString(
      "conn1",
      "gid://shopify/Product/123",
    );

    expect(result.value).toBe("gid://shopify/Product/999");
    expect(result.translated).toBe(1);
    expect(result.unmapped).toBe(0);
  });

  it("keeps unmapped GIDs as-is instead of nulling the value (fix 1A)", async () => {
    getMappingByProductionGid.mockResolvedValue(null);

    const result = await translateGidsInString(
      "conn1",
      "gid://shopify/Product/123",
    );

    // CRITICAL: value should NOT be null — it should keep the original GID
    expect(result.value).toBe("gid://shopify/Product/123");
    expect(result.skipped).toBe(false);
    expect(result.unmapped).toBe(1);
  });

  it("partially translates when some GIDs are mapped and some are not (fix 1A)", async () => {
    getMappingByProductionGid
      .mockResolvedValueOnce({
        stagingGid: "gid://shopify/Product/999",
        resourceType: "product",
      })
      .mockResolvedValueOnce(null);

    const result = await translateGidsInString(
      "conn1",
      '["gid://shopify/Product/111","gid://shopify/Product/222"]',
    );

    expect(result.value).toContain("gid://shopify/Product/999");
    expect(result.value).toContain("gid://shopify/Product/222");
    expect(result.translated).toBe(1);
    expect(result.unmapped).toBe(1);
    expect(result.partiallyTranslated).toBe(true);
  });

  it("returns original value when no GIDs found", async () => {
    const result = await translateGidsInString("conn1", "just text");
    expect(result.value).toBe("just text");
    expect(result.translated).toBe(0);
  });
});

describe("translateGidsInArray", () => {
  it("keeps unmapped items in array instead of dropping them (fix 1A)", async () => {
    getMappingByProductionGid
      .mockResolvedValueOnce({
        stagingGid: "gid://shopify/Product/999",
        resourceType: "product",
      })
      .mockResolvedValueOnce(null);

    const result = await translateGidsInArray("conn1", [
      "gid://shopify/Product/111",
      "gid://shopify/Product/222",
    ]);

    // Both items should be in the array — unmapped one keeps production GID
    expect(result.value).toHaveLength(2);
    expect(result.value[0]).toBe("gid://shopify/Product/999");
    expect(result.value[1]).toBe("gid://shopify/Product/222");
  });
});

describe("translateMetafieldValue — reference types (fix 1B)", () => {
  it("translates product_reference type", async () => {
    getMappingByProductionGid.mockResolvedValue({
      stagingGid: "gid://shopify/Product/999",
      resourceType: "product",
    });

    const result = await translateMetafieldValue("conn1", {
      namespace: "custom",
      key: "related",
      value: "gid://shopify/Product/123",
      type: "product_reference",
    });

    expect(result.value).toBe("gid://shopify/Product/999");
    expect(result.translationStats.translated).toBe(1);
  });

  it("translates collection_reference type", async () => {
    getMappingByProductionGid.mockResolvedValue({
      stagingGid: "gid://shopify/Collection/999",
      resourceType: "collection",
    });

    const result = await translateMetafieldValue("conn1", {
      namespace: "custom",
      key: "col",
      value: "gid://shopify/Collection/123",
      type: "collection_reference",
    });

    expect(result.value).toBe("gid://shopify/Collection/999");
  });

  it("translates variant_reference type", async () => {
    getMappingByProductionGid.mockResolvedValue({
      stagingGid: "gid://shopify/ProductVariant/999",
      resourceType: "variant",
    });

    const result = await translateMetafieldValue("conn1", {
      namespace: "custom",
      key: "var",
      value: "gid://shopify/ProductVariant/123",
      type: "variant_reference",
    });

    expect(result.value).toBe("gid://shopify/ProductVariant/999");
  });

  it("translates list.product_reference type", async () => {
    getMappingByProductionGid
      .mockResolvedValueOnce({
        stagingGid: "gid://shopify/Product/991",
        resourceType: "product",
      })
      .mockResolvedValueOnce({
        stagingGid: "gid://shopify/Product/992",
        resourceType: "product",
      });

    const result = await translateMetafieldValue("conn1", {
      namespace: "custom",
      key: "related_products",
      value: '["gid://shopify/Product/111","gid://shopify/Product/222"]',
      type: "list.product_reference",
    });

    const parsed = JSON.parse(result.value);
    expect(parsed).toEqual([
      "gid://shopify/Product/991",
      "gid://shopify/Product/992",
    ]);
    expect(result.translationStats.translated).toBe(2);
  });

  it("keeps unmapped GID in single reference instead of nulling (fix 1A + 1B)", async () => {
    getMappingByProductionGid.mockResolvedValue(null);

    const result = await translateMetafieldValue("conn1", {
      namespace: "custom",
      key: "related",
      value: "gid://shopify/Product/123",
      type: "product_reference",
    });

    // Should keep original GID, not null
    expect(result.value).toBe("gid://shopify/Product/123");
    expect(result.translationStats.unmapped).toBe(1);
  });

  it("keeps unmapped GIDs in list reference (fix 1A + 1B)", async () => {
    getMappingByProductionGid
      .mockResolvedValueOnce({
        stagingGid: "gid://shopify/Product/999",
        resourceType: "product",
      })
      .mockResolvedValueOnce(null);

    const result = await translateMetafieldValue("conn1", {
      namespace: "custom",
      key: "related_products",
      value: '["gid://shopify/Product/111","gid://shopify/Product/222"]',
      type: "list.product_reference",
    });

    const parsed = JSON.parse(result.value);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toBe("gid://shopify/Product/999");
    expect(parsed[1]).toBe("gid://shopify/Product/222"); // kept original
  });

  it("passes through non-reference types without translation", async () => {
    const result = await translateMetafieldValue("conn1", {
      namespace: "custom",
      key: "color",
      value: "#ff0000",
      type: "color",
    });

    expect(result.value).toBe("#ff0000");
    expect(result.translationStats.translated).toBe(0);
  });
});

describe("translateMetafields", () => {
  it("includes all metafields even when some have unmapped GIDs (fix 1A)", async () => {
    getMappingByProductionGid.mockResolvedValue(null);

    const result = await translateMetafields("conn1", [
      {
        namespace: "custom",
        key: "ref1",
        value: "gid://shopify/Product/123",
        type: "product_reference",
      },
      {
        namespace: "custom",
        key: "color",
        value: "#ff0000",
        type: "color",
      },
    ]);

    // Both metafields should be included (previously, ref1 would be skipped)
    expect(result.metafields).toHaveLength(2);
    expect(result.stats.skipped).toBe(0);
  });
});
