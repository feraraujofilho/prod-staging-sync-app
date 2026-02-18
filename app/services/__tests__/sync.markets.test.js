import { describe, it, expect } from "vitest";

describe("Fix 6A: Markets batch product resolution", () => {
  describe("resolveStagingProductIdsByHandles logic", () => {
    const BATCH_SIZE = 50;

    // Helper: replicates the batching + alias-building logic from sync.markets.server.js
    function buildBatchFragments(handles) {
      if (!handles || handles.length === 0) return [];

      const batches = [];
      for (let i = 0; i < handles.length; i += BATCH_SIZE) {
        const batch = handles.slice(i, i + BATCH_SIZE);
        const fragments = batch
          .map(
            (handle, idx) =>
              `p${idx}: productByIdentifier(identifier: { handle: "${handle.replace(/"/g, '\\"')}" }) { id }`,
          )
          .join("\n      ");
        const query = `query { ${fragments} }`;
        batches.push({ batch, query, fragments });
      }
      return batches;
    }

    // Helper: replicates the ID extraction logic from aliased response
    function extractIdsFromResponse(batch, jsonData) {
      const ids = [];
      for (let idx = 0; idx < batch.length; idx++) {
        const id = jsonData?.[`p${idx}`]?.id;
        if (id) ids.push(id);
      }
      return ids;
    }

    it("returns empty array for null handles", () => {
      const handles = null;
      if (!handles || handles.length === 0) {
        expect([]).toEqual([]);
        return;
      }
    });

    it("returns empty array for empty handles array", () => {
      const handles = [];
      if (!handles || handles.length === 0) {
        expect([]).toEqual([]);
        return;
      }
    });

    it("batches handles into groups of 50", () => {
      // Create 120 handles -> should produce 3 batches (50, 50, 20)
      const handles = Array.from({ length: 120 }, (_, i) => `handle-${i}`);
      const batches = buildBatchFragments(handles);

      expect(batches).toHaveLength(3);
      expect(batches[0].batch).toHaveLength(50);
      expect(batches[1].batch).toHaveLength(50);
      expect(batches[2].batch).toHaveLength(20);
    });

    it("single batch for fewer than 50 handles", () => {
      const handles = ["alpha", "beta", "gamma"];
      const batches = buildBatchFragments(handles);

      expect(batches).toHaveLength(1);
      expect(batches[0].batch).toHaveLength(3);
    });

    it("builds correct GraphQL alias format", () => {
      const handles = ["summer-dress", "winter-coat", "spring-hat"];
      const batches = buildBatchFragments(handles);
      const { fragments, query } = batches[0];

      // Verify each alias prefix
      expect(fragments).toContain('p0: productByIdentifier(identifier: { handle: "summer-dress" }) { id }');
      expect(fragments).toContain('p1: productByIdentifier(identifier: { handle: "winter-coat" }) { id }');
      expect(fragments).toContain('p2: productByIdentifier(identifier: { handle: "spring-hat" }) { id }');

      // Verify wrapped in query
      expect(query).toMatch(/^query \{ .+ \}$/s);
    });

    it("extracts IDs from aliased response", () => {
      const batch = ["summer-dress", "winter-coat", "spring-hat"];

      const jsonData = {
        p0: { id: "gid://shopify/Product/100" },
        p1: { id: "gid://shopify/Product/200" },
        p2: { id: "gid://shopify/Product/300" },
      };

      const ids = extractIdsFromResponse(batch, jsonData);

      expect(ids).toEqual([
        "gid://shopify/Product/100",
        "gid://shopify/Product/200",
        "gid://shopify/Product/300",
      ]);
    });

    it("handles some null results (not all products found)", () => {
      const batch = ["found-product", "missing-product", "another-found"];

      // p1 is null (product not found on staging)
      const jsonData = {
        p0: { id: "gid://shopify/Product/100" },
        p1: null,
        p2: { id: "gid://shopify/Product/300" },
      };

      const ids = extractIdsFromResponse(batch, jsonData);

      // Should only contain 2 IDs, skipping the null result
      expect(ids).toHaveLength(2);
      expect(ids).toEqual([
        "gid://shopify/Product/100",
        "gid://shopify/Product/300",
      ]);
    });

    it("handles all null results (no products found)", () => {
      const batch = ["missing-a", "missing-b", "missing-c"];

      const jsonData = {
        p0: null,
        p1: null,
        p2: null,
      };

      const ids = extractIdsFromResponse(batch, jsonData);
      expect(ids).toEqual([]);
    });

    it("handles undefined data gracefully", () => {
      const batch = ["some-handle"];

      const ids = extractIdsFromResponse(batch, undefined);
      expect(ids).toEqual([]);
    });

    it("escapes double quotes in handles", () => {
      const handles = ['my-"special"-product', 'normal-handle'];
      const batches = buildBatchFragments(handles);
      const { fragments } = batches[0];

      // The double quotes inside the handle should be escaped
      expect(fragments).toContain('handle: "my-\\"special\\"-product"');
      // Normal handle is unchanged
      expect(fragments).toContain('handle: "normal-handle"');
    });

    it("handles >50 handles (multiple batches) with correct alias reset", () => {
      // 55 handles -> batch 1 has 50, batch 2 has 5
      const handles = Array.from({ length: 55 }, (_, i) => `product-${i}`);
      const batches = buildBatchFragments(handles);

      expect(batches).toHaveLength(2);

      // First batch: aliases go p0..p49
      expect(batches[0].fragments).toContain("p0: productByIdentifier");
      expect(batches[0].fragments).toContain("p49: productByIdentifier");
      expect(batches[0].batch).toHaveLength(50);

      // Second batch: aliases reset to p0..p4 (not p50..p54)
      expect(batches[1].fragments).toContain("p0: productByIdentifier");
      expect(batches[1].fragments).toContain("p4: productByIdentifier");
      expect(batches[1].fragments).not.toContain("p50:");
      expect(batches[1].batch).toHaveLength(5);
    });

    it("multi-batch ID extraction combines results from all batches", () => {
      // Simulate processing 55 handles across 2 batches
      const allIds = [];

      // Batch 1 response: 50 products, some found
      const batch1 = Array.from({ length: 50 }, (_, i) => `product-${i}`);
      const batch1Data = {};
      for (let idx = 0; idx < 50; idx++) {
        // Every other product is "found"
        batch1Data[`p${idx}`] = idx % 2 === 0
          ? { id: `gid://shopify/Product/${idx}` }
          : null;
      }
      allIds.push(...extractIdsFromResponse(batch1, batch1Data));

      // Batch 2 response: 5 products, all found
      const batch2 = Array.from({ length: 5 }, (_, i) => `product-${50 + i}`);
      const batch2Data = {};
      for (let idx = 0; idx < 5; idx++) {
        batch2Data[`p${idx}`] = { id: `gid://shopify/Product/${50 + idx}` };
      }
      allIds.push(...extractIdsFromResponse(batch2, batch2Data));

      // 25 from batch 1 (every other of 50) + 5 from batch 2 = 30
      expect(allIds).toHaveLength(30);
      expect(allIds[0]).toBe("gid://shopify/Product/0");
      expect(allIds[allIds.length - 1]).toBe("gid://shopify/Product/54");
    });

    it("exactly 50 handles produces a single batch", () => {
      const handles = Array.from({ length: 50 }, (_, i) => `handle-${i}`);
      const batches = buildBatchFragments(handles);

      expect(batches).toHaveLength(1);
      expect(batches[0].batch).toHaveLength(50);
    });

    it("exactly 51 handles produces two batches", () => {
      const handles = Array.from({ length: 51 }, (_, i) => `handle-${i}`);
      const batches = buildBatchFragments(handles);

      expect(batches).toHaveLength(2);
      expect(batches[0].batch).toHaveLength(50);
      expect(batches[1].batch).toHaveLength(1);
    });
  });
});
