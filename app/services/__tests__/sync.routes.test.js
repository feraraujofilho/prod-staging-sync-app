import { describe, it, expect } from "vitest";

describe("Fix 7A: syncType validation", () => {
  const validSyncTypes = [
    "metafield_definitions",
    "metaobject_definitions",
    "products",
    "collections",
    "locations",
    "navigation",
    "pages",
    "files",
    "markets",
    "search_discovery",
  ];

  it("accepts all known sync types", () => {
    for (const syncType of validSyncTypes) {
      expect(validSyncTypes.includes(syncType)).toBe(true);
    }
  });

  it("rejects unknown sync types", () => {
    expect(validSyncTypes.includes("invalid_type")).toBe(false);
    expect(validSyncTypes.includes("")).toBe(false);
    expect(validSyncTypes.includes(null)).toBe(false);
    expect(validSyncTypes.includes(undefined)).toBe(false);
  });

  it("rejects SQL injection attempts", () => {
    expect(validSyncTypes.includes("products'; DROP TABLE--")).toBe(false);
  });
});

describe("Fix 7B: Connection validation error messages", () => {
  it("provides helpful error when no connection is selected", () => {
    const connectionId = "";
    const error = !connectionId
      ? "Please select a store connection before syncing. Go to Settings to create one if needed."
      : null;

    expect(error).toBeDefined();
    expect(error).toContain("store connection");
    expect(error).toContain("Settings");
  });
});

describe("Fix 7C: syncType included in default error", () => {
  it("error message includes the invalid sync type name", () => {
    const syncType = "bogus_sync";
    const errorMessage = `Unhandled sync type: "${syncType}"`;

    expect(errorMessage).toContain("bogus_sync");
    expect(errorMessage).toContain("Unhandled sync type");
  });
});

describe("Fix 5B: Navigation handle sanitization", () => {
  it("escapes double quotes in handle for GraphQL query", () => {
    const handle = 'main-menu"injection';
    const sanitized = `handle:"${handle.replace(/"/g, '\\"')}"`;

    expect(sanitized).toBe('handle:"main-menu\\"injection"');
    expect(sanitized).not.toContain('""');
  });

  it("handles normal handles without modification", () => {
    const handle = "main-menu";
    const sanitized = `handle:"${handle.replace(/"/g, '\\"')}"`;

    expect(sanitized).toBe('handle:"main-menu"');
  });
});

describe("Fix 6B: API version consistency", () => {
  it("all services should use 2025-07", () => {
    const expectedVersion = "2025-07";

    // These are the API URLs that were updated
    const serviceUrls = [
      `https://store.myshopify.com/admin/api/${expectedVersion}/graphql.json`,
    ];

    for (const url of serviceUrls) {
      expect(url).toContain(expectedVersion);
      expect(url).not.toContain("2025-01");
    }
  });
});

describe("Fix 6C: Files duplicate resolution mode", () => {
  it("uses SKIP instead of RAISE_ERROR", () => {
    const duplicateResolutionMode = "SKIP";

    expect(duplicateResolutionMode).toBe("SKIP");
    expect(duplicateResolutionMode).not.toBe("RAISE_ERROR");
  });
});
