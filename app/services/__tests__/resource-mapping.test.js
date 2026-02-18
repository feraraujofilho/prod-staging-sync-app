import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  extractIdFromGid,
  extractResourceTypeFromGid,
  normalizeResourceType,
} from "../resource-mapping.server.js";

// We test the pure functions directly — no DB mocking needed

describe("extractIdFromGid", () => {
  it("extracts numeric ID from a standard GID", () => {
    expect(extractIdFromGid("gid://shopify/Product/123456")).toBe("123456");
  });

  it("extracts numeric ID from variant GID", () => {
    expect(extractIdFromGid("gid://shopify/ProductVariant/789")).toBe("789");
  });

  it("returns null for null/undefined input", () => {
    expect(extractIdFromGid(null)).toBeNull();
    expect(extractIdFromGid(undefined)).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(extractIdFromGid("")).toBeNull();
  });

  it("returns null for string without numeric ending", () => {
    expect(extractIdFromGid("gid://shopify/Product/")).toBeNull();
  });
});

describe("extractResourceTypeFromGid", () => {
  it("extracts Product type", () => {
    expect(extractResourceTypeFromGid("gid://shopify/Product/123")).toBe(
      "Product",
    );
  });

  it("extracts ProductVariant type", () => {
    expect(
      extractResourceTypeFromGid("gid://shopify/ProductVariant/456"),
    ).toBe("ProductVariant");
  });

  it("extracts Collection type", () => {
    expect(extractResourceTypeFromGid("gid://shopify/Collection/789")).toBe(
      "Collection",
    );
  });

  it("extracts InventoryItem type", () => {
    expect(extractResourceTypeFromGid("gid://shopify/InventoryItem/111")).toBe(
      "InventoryItem",
    );
  });

  it("returns null for null/undefined input", () => {
    expect(extractResourceTypeFromGid(null)).toBeNull();
    expect(extractResourceTypeFromGid(undefined)).toBeNull();
  });

  it("returns null for invalid GID format", () => {
    expect(extractResourceTypeFromGid("not-a-gid")).toBeNull();
  });
});

describe("normalizeResourceType", () => {
  it("maps Product to product", () => {
    expect(normalizeResourceType("Product")).toBe("product");
  });

  it("maps ProductVariant to variant", () => {
    expect(normalizeResourceType("ProductVariant")).toBe("variant");
  });

  it("maps Collection to collection", () => {
    expect(normalizeResourceType("Collection")).toBe("collection");
  });

  it("maps Market to market", () => {
    expect(normalizeResourceType("Market")).toBe("market");
  });

  it("maps Location to location", () => {
    expect(normalizeResourceType("Location")).toBe("location");
  });

  // Fix 1D: These types were missing and added in the fix
  it("maps InventoryItem to inventory_item (fix 1D)", () => {
    expect(normalizeResourceType("InventoryItem")).toBe("inventory_item");
  });

  it("maps InventoryLevel to inventory_level (fix 1D)", () => {
    expect(normalizeResourceType("InventoryLevel")).toBe("inventory_level");
  });

  it("maps MetaobjectDefinition to metaobject_definition (fix 1D)", () => {
    expect(normalizeResourceType("MetaobjectDefinition")).toBe(
      "metaobject_definition",
    );
  });

  it("maps Page to page", () => {
    expect(normalizeResourceType("Page")).toBe("page");
  });

  it("maps MediaImage to file", () => {
    expect(normalizeResourceType("MediaImage")).toBe("file");
  });

  it("maps GenericFile to file", () => {
    expect(normalizeResourceType("GenericFile")).toBe("file");
  });

  it("maps Video to file", () => {
    expect(normalizeResourceType("Video")).toBe("file");
  });

  it("maps Metaobject to metaobject", () => {
    expect(normalizeResourceType("Metaobject")).toBe("metaobject");
  });

  it("maps Menu to navigation", () => {
    expect(normalizeResourceType("Menu")).toBe("navigation");
  });

  it("falls back to lowercase for unknown types", () => {
    expect(normalizeResourceType("CustomThing")).toBe("customthing");
  });

  it("handles null/undefined gracefully", () => {
    expect(normalizeResourceType(null)).toBeUndefined();
    expect(normalizeResourceType(undefined)).toBeUndefined();
  });
});
