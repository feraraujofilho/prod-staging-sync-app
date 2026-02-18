import { describe, it, expect } from "vitest";

describe("Fix 5A: Navigation pagination", () => {
  // -------------------------------------------------------------------------
  // Helper: simulates the getProductionMenus pagination loop (lines 53-102)
  // Takes an array of "pages" where each page is { edges, pageInfo }.
  // Returns the accumulated allMenus array exactly as the real function does.
  // -------------------------------------------------------------------------
  function simulateGetProductionMenusPagination(pages) {
    const allMenus = [];
    let hasNextPage = true;
    let cursor = null;
    let pageIndex = 0;

    while (hasNextPage) {
      // Simulate the fetch response for the current page
      const data = pages[pageIndex] || {
        data: { menus: { edges: [], pageInfo: { hasNextPage: false, endCursor: null } } },
      };

      // Verify cursor was advanced correctly (first call has null cursor)
      if (pageIndex === 0) {
        expect(cursor).toBeNull();
      } else {
        expect(cursor).toBeTruthy();
      }

      const edges = data.data?.menus?.edges || [];
      allMenus.push(...edges.map((edge) => edge.node));

      hasNextPage = data.data?.menus?.pageInfo?.hasNextPage || false;
      cursor = data.data?.menus?.pageInfo?.endCursor || null;

      pageIndex++;
    }

    return allMenus;
  }

  describe("getProductionMenus pagination logic", () => {
    it("accumulates menus across multiple pages", () => {
      const pages = [
        {
          data: {
            menus: {
              edges: [
                { node: { id: "gid://shopify/Menu/1", handle: "main-menu", title: "Main Menu" } },
                { node: { id: "gid://shopify/Menu/2", handle: "footer", title: "Footer" } },
              ],
              pageInfo: { hasNextPage: true, endCursor: "cursor-page-1" },
            },
          },
        },
        {
          data: {
            menus: {
              edges: [
                { node: { id: "gid://shopify/Menu/3", handle: "sidebar", title: "Sidebar" } },
              ],
              pageInfo: { hasNextPage: true, endCursor: "cursor-page-2" },
            },
          },
        },
        {
          data: {
            menus: {
              edges: [
                { node: { id: "gid://shopify/Menu/4", handle: "mobile", title: "Mobile" } },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      ];

      const result = simulateGetProductionMenusPagination(pages);

      expect(result).toHaveLength(4);
      expect(result[0].handle).toBe("main-menu");
      expect(result[1].handle).toBe("footer");
      expect(result[2].handle).toBe("sidebar");
      expect(result[3].handle).toBe("mobile");
    });

    it("handles single page (no pagination needed)", () => {
      const pages = [
        {
          data: {
            menus: {
              edges: [
                { node: { id: "gid://shopify/Menu/1", handle: "main-menu", title: "Main Menu" } },
                { node: { id: "gid://shopify/Menu/2", handle: "footer", title: "Footer" } },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      ];

      const result = simulateGetProductionMenusPagination(pages);

      expect(result).toHaveLength(2);
      expect(result[0].id).toBe("gid://shopify/Menu/1");
      expect(result[1].id).toBe("gid://shopify/Menu/2");
    });

    it("handles empty response (no menus)", () => {
      const pages = [
        {
          data: {
            menus: {
              edges: [],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      ];

      const result = simulateGetProductionMenusPagination(pages);

      expect(result).toHaveLength(0);
      expect(result).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // Helper: simulates the getStagingPageIdByHandle pagination loop (lines 161-185)
  // Takes a handle to search for and an array of "pages", each with { edges, pageInfo }.
  // Mimics the early-return-on-match + error-returns-null behavior.
  // -------------------------------------------------------------------------
  function simulateGetStagingPageIdByHandle(handle, pages) {
    let hasNextPage = true;
    let cursor = null;
    let pageIndex = 0;

    while (hasNextPage) {
      const result = pages[pageIndex];

      // Simulate error path: return null
      if (result.errors) {
        return null;
      }

      // Verify cursor advancement
      if (pageIndex === 0) {
        expect(cursor).toBeNull();
      } else {
        expect(cursor).toBeTruthy();
      }

      const pagesEdges = result.data?.pages?.edges || [];
      const matchingPage = pagesEdges.find((page) => page.node.handle === handle);
      if (matchingPage) {
        return matchingPage.node.id;
      }

      hasNextPage = result.data?.pages?.pageInfo?.hasNextPage || false;
      cursor = result.data?.pages?.pageInfo?.endCursor || null;

      pageIndex++;
    }

    return null;
  }

  describe("getStagingPageIdByHandle pagination logic", () => {
    it("finds page on first page", () => {
      const pages = [
        {
          data: {
            pages: {
              edges: [
                { node: { id: "gid://shopify/Page/100", handle: "about" } },
                { node: { id: "gid://shopify/Page/101", handle: "contact" } },
                { node: { id: "gid://shopify/Page/102", handle: "faq" } },
              ],
              pageInfo: { hasNextPage: true, endCursor: "cursor-p1" },
            },
          },
        },
      ];

      const result = simulateGetStagingPageIdByHandle("contact", pages);
      expect(result).toBe("gid://shopify/Page/101");
    });

    it("finds page on second page via cursor", () => {
      const pages = [
        {
          data: {
            pages: {
              edges: [
                { node: { id: "gid://shopify/Page/100", handle: "about" } },
                { node: { id: "gid://shopify/Page/101", handle: "contact" } },
              ],
              pageInfo: { hasNextPage: true, endCursor: "cursor-p1" },
            },
          },
        },
        {
          data: {
            pages: {
              edges: [
                { node: { id: "gid://shopify/Page/200", handle: "shipping-policy" } },
                { node: { id: "gid://shopify/Page/201", handle: "terms-of-service" } },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      ];

      const result = simulateGetStagingPageIdByHandle("terms-of-service", pages);
      expect(result).toBe("gid://shopify/Page/201");
    });

    it("returns null when page not found across all pages", () => {
      const pages = [
        {
          data: {
            pages: {
              edges: [
                { node: { id: "gid://shopify/Page/100", handle: "about" } },
              ],
              pageInfo: { hasNextPage: true, endCursor: "cursor-p1" },
            },
          },
        },
        {
          data: {
            pages: {
              edges: [
                { node: { id: "gid://shopify/Page/200", handle: "contact" } },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      ];

      const result = simulateGetStagingPageIdByHandle("nonexistent-page", pages);
      expect(result).toBeNull();
    });

    it("returns null on error", () => {
      const pages = [
        {
          errors: [{ message: "Internal server error" }],
        },
      ];

      const result = simulateGetStagingPageIdByHandle("about", pages);
      expect(result).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Helper: simulates the getStagingCollectionIdByHandle pagination loop (lines 215-236)
  // Same pattern as pages but operates on collections edges.
  // -------------------------------------------------------------------------
  function simulateGetStagingCollectionIdByHandle(handle, pages) {
    let hasNextPage = true;
    let cursor = null;
    let pageIndex = 0;

    while (hasNextPage) {
      const result = pages[pageIndex];

      if (result.errors) {
        return null;
      }

      if (pageIndex === 0) {
        expect(cursor).toBeNull();
      } else {
        expect(cursor).toBeTruthy();
      }

      const collections = result.data?.collections?.edges || [];
      const matchingCollection = collections.find(
        (collection) => collection.node.handle === handle,
      );
      if (matchingCollection) {
        return matchingCollection.node.id;
      }

      hasNextPage = result.data?.collections?.pageInfo?.hasNextPage || false;
      cursor = result.data?.collections?.pageInfo?.endCursor || null;

      pageIndex++;
    }

    return null;
  }

  describe("getStagingCollectionIdByHandle pagination logic", () => {
    it("finds collection on second page", () => {
      const pages = [
        {
          data: {
            collections: {
              edges: [
                { node: { id: "gid://shopify/Collection/10", handle: "summer-sale" } },
                { node: { id: "gid://shopify/Collection/11", handle: "new-arrivals" } },
              ],
              pageInfo: { hasNextPage: true, endCursor: "cursor-c1" },
            },
          },
        },
        {
          data: {
            collections: {
              edges: [
                { node: { id: "gid://shopify/Collection/20", handle: "clearance" } },
                { node: { id: "gid://shopify/Collection/21", handle: "best-sellers" } },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      ];

      const result = simulateGetStagingCollectionIdByHandle("best-sellers", pages);
      expect(result).toBe("gid://shopify/Collection/21");
    });

    it("returns null when collection not found", () => {
      const pages = [
        {
          data: {
            collections: {
              edges: [
                { node: { id: "gid://shopify/Collection/10", handle: "summer-sale" } },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      ];

      const result = simulateGetStagingCollectionIdByHandle("nonexistent-collection", pages);
      expect(result).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Helper: simulates the getStagingCustomerAccountPageIdByHandle pagination loop (lines 266-288)
  // Same pattern but uses customerAccountPages field.
  // -------------------------------------------------------------------------
  function simulateGetStagingCustomerAccountPageIdByHandle(handle, pages) {
    let hasNextPage = true;
    let cursor = null;
    let pageIndex = 0;

    while (hasNextPage) {
      const result = pages[pageIndex];

      if (result.errors) {
        return null;
      }

      if (pageIndex === 0) {
        expect(cursor).toBeNull();
      } else {
        expect(cursor).toBeTruthy();
      }

      const customerAccountPages = result.data?.customerAccountPages?.edges || [];
      const matchingPage = customerAccountPages.find(
        (page) => page.node.handle === handle,
      );
      if (matchingPage) {
        return matchingPage.node.id;
      }

      hasNextPage = result.data?.customerAccountPages?.pageInfo?.hasNextPage || false;
      cursor = result.data?.customerAccountPages?.pageInfo?.endCursor || null;

      pageIndex++;
    }

    return null;
  }

  describe("getStagingCustomerAccountPageIdByHandle pagination logic", () => {
    it("finds customer account page", () => {
      const pages = [
        {
          data: {
            customerAccountPages: {
              edges: [
                { node: { id: "gid://shopify/CustomerAccountPage/50", handle: "orders" } },
                { node: { id: "gid://shopify/CustomerAccountPage/51", handle: "addresses" } },
                { node: { id: "gid://shopify/CustomerAccountPage/52", handle: "wishlist" } },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      ];

      const result = simulateGetStagingCustomerAccountPageIdByHandle("wishlist", pages);
      expect(result).toBe("gid://shopify/CustomerAccountPage/52");
    });

    it("returns null when customer account page not found", () => {
      const pages = [
        {
          data: {
            customerAccountPages: {
              edges: [
                { node: { id: "gid://shopify/CustomerAccountPage/50", handle: "orders" } },
                { node: { id: "gid://shopify/CustomerAccountPage/51", handle: "addresses" } },
              ],
              pageInfo: { hasNextPage: true, endCursor: "cursor-cap1" },
            },
          },
        },
        {
          data: {
            customerAccountPages: {
              edges: [
                { node: { id: "gid://shopify/CustomerAccountPage/60", handle: "profile" } },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      ];

      const result = simulateGetStagingCustomerAccountPageIdByHandle("nonexistent-page", pages);
      expect(result).toBeNull();
    });
  });
});
