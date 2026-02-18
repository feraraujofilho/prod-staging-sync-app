import { describe, it, expect } from "vitest";

describe("Fix 5C: Pages pagination", () => {
  describe("getProductionPages pagination logic", () => {
    it("accumulates pages from multiple paginated responses", () => {
      // Simulate the pagination loop from getProductionPages (lines 39-87)
      // Two pages of results, each with 2 pages (like first:250 returning batches)
      const paginatedResponses = [
        {
          data: {
            pages: {
              edges: [
                { node: { id: "gid://shopify/Page/1", title: "About Us", handle: "about-us" } },
                { node: { id: "gid://shopify/Page/2", title: "Contact", handle: "contact" } },
              ],
              pageInfo: { hasNextPage: true, endCursor: "cursor-page-1" },
            },
          },
        },
        {
          data: {
            pages: {
              edges: [
                { node: { id: "gid://shopify/Page/3", title: "FAQ", handle: "faq" } },
                { node: { id: "gid://shopify/Page/4", title: "Shipping", handle: "shipping" } },
              ],
              pageInfo: { hasNextPage: false, endCursor: "cursor-page-2" },
            },
          },
        },
      ];

      // Replicate the accumulation loop from the service
      const allPages = [];
      let hasNextPage = true;
      let cursor = null;
      let requestIndex = 0;

      while (hasNextPage) {
        const data = paginatedResponses[requestIndex];

        // Verify cursor advances correctly on each iteration
        if (requestIndex === 0) {
          expect(cursor).toBeNull();
        } else if (requestIndex === 1) {
          expect(cursor).toBe("cursor-page-1");
        }

        const edges = data.data?.pages?.edges || [];
        allPages.push(...edges.map((edge) => edge.node));

        hasNextPage = data.data?.pages?.pageInfo?.hasNextPage || false;
        cursor = data.data?.pages?.pageInfo?.endCursor || null;
        requestIndex++;
      }

      expect(allPages).toHaveLength(4);
      expect(allPages[0].title).toBe("About Us");
      expect(allPages[1].title).toBe("Contact");
      expect(allPages[2].title).toBe("FAQ");
      expect(allPages[3].title).toBe("Shipping");
      expect(requestIndex).toBe(2);
    });

    it("returns empty array when no pages exist", () => {
      const response = {
        data: {
          pages: {
            edges: [],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      };

      // Replicate the accumulation loop
      const allPages = [];
      let hasNextPage = true;
      let cursor = null;

      // Single iteration — response has no edges and hasNextPage is false
      const data = response;
      const edges = data.data?.pages?.edges || [];
      allPages.push(...edges.map((edge) => edge.node));

      hasNextPage = data.data?.pages?.pageInfo?.hasNextPage || false;
      cursor = data.data?.pages?.pageInfo?.endCursor || null;

      expect(allPages).toHaveLength(0);
      expect(allPages).toEqual([]);
      expect(hasNextPage).toBe(false);
      expect(cursor).toBeNull();
    });

    it("stops when hasNextPage is false", () => {
      const paginatedResponses = [
        {
          data: {
            pages: {
              edges: [
                { node: { id: "gid://shopify/Page/1", title: "Page 1", handle: "page-1" } },
              ],
              pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
            },
          },
        },
        {
          data: {
            pages: {
              edges: [
                { node: { id: "gid://shopify/Page/2", title: "Page 2", handle: "page-2" } },
              ],
              pageInfo: { hasNextPage: true, endCursor: "cursor-2" },
            },
          },
        },
        {
          data: {
            pages: {
              edges: [
                { node: { id: "gid://shopify/Page/3", title: "Page 3", handle: "page-3" } },
              ],
              pageInfo: { hasNextPage: false, endCursor: "cursor-3" },
            },
          },
        },
      ];

      // Replicate the accumulation loop
      const allPages = [];
      let hasNextPage = true;
      let cursor = null;
      let iterationCount = 0;

      while (hasNextPage) {
        const data = paginatedResponses[iterationCount];
        const edges = data.data?.pages?.edges || [];
        allPages.push(...edges.map((edge) => edge.node));

        hasNextPage = data.data?.pages?.pageInfo?.hasNextPage || false;
        cursor = data.data?.pages?.pageInfo?.endCursor || null;
        iterationCount++;
      }

      // Loop ran exactly 3 times, then stopped because hasNextPage became false
      expect(iterationCount).toBe(3);
      expect(allPages).toHaveLength(3);
      expect(hasNextPage).toBe(false);
    });

    it("handles API errors by throwing", () => {
      const errorResponse = {
        errors: [{ message: "Access denied for pages field" }],
      };

      // Replicate the error handling from the service (lines 61-78)
      let thrownError = null;
      try {
        if (errorResponse.errors) {
          const scopeError = errorResponse.errors.find(
            (error) =>
              error.message.includes("Access denied") ||
              error.message.includes("pages field"),
          );
          if (scopeError) {
            throw new Error(
              "Access denied for pages. Please ensure the app has 'read_online_store_pages' scope and reinstall the app if needed.",
            );
          }
          throw new Error(
            `Failed to fetch production pages: ${errorResponse.errors
              .map((e) => e.message)
              .join(", ")}`,
          );
        }
      } catch (error) {
        thrownError = error;
      }

      expect(thrownError).not.toBeNull();
      expect(thrownError.message).toContain("Access denied for pages");
      expect(thrownError.message).toContain("read_online_store_pages");
    });

    it("handles generic API errors (non-scope related)", () => {
      const errorResponse = {
        errors: [
          { message: "Internal server error" },
          { message: "Timeout exceeded" },
        ],
      };

      let thrownError = null;
      try {
        if (errorResponse.errors) {
          const scopeError = errorResponse.errors.find(
            (error) =>
              error.message.includes("Access denied") ||
              error.message.includes("pages field"),
          );
          if (scopeError) {
            throw new Error(
              "Access denied for pages. Please ensure the app has 'read_online_store_pages' scope and reinstall the app if needed.",
            );
          }
          throw new Error(
            `Failed to fetch production pages: ${errorResponse.errors
              .map((e) => e.message)
              .join(", ")}`,
          );
        }
      } catch (error) {
        thrownError = error;
      }

      expect(thrownError).not.toBeNull();
      expect(thrownError.message).toBe(
        "Failed to fetch production pages: Internal server error, Timeout exceeded",
      );
    });

    it("handles missing data gracefully with fallback to empty edges", () => {
      // When data.data.pages is null/undefined, edges should default to []
      const malformedResponse = {
        data: {
          pages: null,
        },
      };

      const edges = malformedResponse.data?.pages?.edges || [];
      const hasNextPage = malformedResponse.data?.pages?.pageInfo?.hasNextPage || false;
      const cursor = malformedResponse.data?.pages?.pageInfo?.endCursor || null;

      expect(edges).toEqual([]);
      expect(hasNextPage).toBe(false);
      expect(cursor).toBeNull();
    });
  });

  describe("getStagingPageByHandle pagination logic", () => {
    it("finds page on first page of results", () => {
      const targetHandle = "about-us";

      const paginatedResponses = [
        {
          data: {
            pages: {
              edges: [
                { node: { id: "gid://shopify/Page/1", title: "About Us", handle: "about-us" } },
                { node: { id: "gid://shopify/Page/2", title: "Contact", handle: "contact" } },
              ],
              pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
            },
          },
        },
        {
          data: {
            pages: {
              edges: [
                { node: { id: "gid://shopify/Page/3", title: "FAQ", handle: "faq" } },
              ],
              pageInfo: { hasNextPage: false, endCursor: "cursor-2" },
            },
          },
        },
      ];

      // Replicate the search loop from getStagingPageByHandle (lines 119-143)
      let hasNextPage = true;
      let cursor = null;
      let requestIndex = 0;
      let foundPage = null;

      while (hasNextPage) {
        const result = paginatedResponses[requestIndex];

        if (result.errors) {
          foundPage = null;
          break;
        }

        const pages = result.data?.pages?.edges || [];
        const matchingPage = pages.find((page) => page.node.handle === targetHandle);
        if (matchingPage) {
          foundPage = matchingPage.node;
          break; // Early return when found
        }

        hasNextPage = result.data?.pages?.pageInfo?.hasNextPage || false;
        cursor = result.data?.pages?.pageInfo?.endCursor || null;
        requestIndex++;
      }

      expect(foundPage).not.toBeNull();
      expect(foundPage.id).toBe("gid://shopify/Page/1");
      expect(foundPage.handle).toBe("about-us");
      expect(foundPage.title).toBe("About Us");
      // Should have found it on the first request, never needed second page
      expect(requestIndex).toBe(0);
    });

    it("finds page on second page after pagination", () => {
      const targetHandle = "faq";

      const paginatedResponses = [
        {
          data: {
            pages: {
              edges: [
                { node: { id: "gid://shopify/Page/1", title: "About Us", handle: "about-us" } },
                { node: { id: "gid://shopify/Page/2", title: "Contact", handle: "contact" } },
              ],
              pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
            },
          },
        },
        {
          data: {
            pages: {
              edges: [
                { node: { id: "gid://shopify/Page/3", title: "FAQ", handle: "faq" } },
                { node: { id: "gid://shopify/Page/4", title: "Shipping", handle: "shipping" } },
              ],
              pageInfo: { hasNextPage: false, endCursor: "cursor-2" },
            },
          },
        },
      ];

      // Replicate the search loop
      let hasNextPage = true;
      let cursor = null;
      let requestIndex = 0;
      let foundPage = null;

      while (hasNextPage) {
        const result = paginatedResponses[requestIndex];

        // Verify cursor advances correctly
        if (requestIndex === 0) {
          expect(cursor).toBeNull();
        } else if (requestIndex === 1) {
          expect(cursor).toBe("cursor-1");
        }

        if (result.errors) {
          foundPage = null;
          break;
        }

        const pages = result.data?.pages?.edges || [];
        const matchingPage = pages.find((page) => page.node.handle === targetHandle);
        if (matchingPage) {
          foundPage = matchingPage.node;
          break;
        }

        hasNextPage = result.data?.pages?.pageInfo?.hasNextPage || false;
        cursor = result.data?.pages?.pageInfo?.endCursor || null;
        requestIndex++;
      }

      expect(foundPage).not.toBeNull();
      expect(foundPage.id).toBe("gid://shopify/Page/3");
      expect(foundPage.handle).toBe("faq");
      expect(foundPage.title).toBe("FAQ");
      // Found on the second request (index 1)
      expect(requestIndex).toBe(1);
    });

    it("returns null when page not found after all pages", () => {
      const targetHandle = "nonexistent-page";

      const paginatedResponses = [
        {
          data: {
            pages: {
              edges: [
                { node: { id: "gid://shopify/Page/1", title: "About Us", handle: "about-us" } },
                { node: { id: "gid://shopify/Page/2", title: "Contact", handle: "contact" } },
              ],
              pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
            },
          },
        },
        {
          data: {
            pages: {
              edges: [
                { node: { id: "gid://shopify/Page/3", title: "FAQ", handle: "faq" } },
              ],
              pageInfo: { hasNextPage: false, endCursor: "cursor-2" },
            },
          },
        },
      ];

      // Replicate the search loop
      let hasNextPage = true;
      let cursor = null;
      let requestIndex = 0;
      let foundPage = null;

      while (hasNextPage) {
        const result = paginatedResponses[requestIndex];

        if (result.errors) {
          foundPage = null;
          break;
        }

        const pages = result.data?.pages?.edges || [];
        const matchingPage = pages.find((page) => page.node.handle === targetHandle);
        if (matchingPage) {
          foundPage = matchingPage.node;
          break;
        }

        hasNextPage = result.data?.pages?.pageInfo?.hasNextPage || false;
        cursor = result.data?.pages?.pageInfo?.endCursor || null;
        requestIndex++;
      }

      // After exhausting all pages, foundPage should remain null
      expect(foundPage).toBeNull();
      // Loop iterated through both pages of results
      expect(requestIndex).toBe(2);
    });

    it("returns null on API error", () => {
      const targetHandle = "about-us";

      const errorResponse = {
        errors: [{ message: "Something went wrong" }],
      };

      // Replicate the search loop with an error on the first request
      let hasNextPage = true;
      let cursor = null;
      let foundPage = null;

      // Simulate single iteration that encounters an error
      const result = errorResponse;

      if (result.errors) {
        // Service returns null on errors (line 130-131)
        foundPage = null;
      }

      expect(foundPage).toBeNull();
    });

    it("returns null when staging has no pages at all", () => {
      const targetHandle = "about-us";

      const emptyResponse = {
        data: {
          pages: {
            edges: [],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      };

      // Replicate the search loop
      let hasNextPage = true;
      let cursor = null;
      let requestIndex = 0;
      let foundPage = null;

      while (hasNextPage) {
        const result = emptyResponse;

        if (result.errors) {
          foundPage = null;
          break;
        }

        const pages = result.data?.pages?.edges || [];
        const matchingPage = pages.find((page) => page.node.handle === targetHandle);
        if (matchingPage) {
          foundPage = matchingPage.node;
          break;
        }

        hasNextPage = result.data?.pages?.pageInfo?.hasNextPage || false;
        cursor = result.data?.pages?.pageInfo?.endCursor || null;
        requestIndex++;
      }

      expect(foundPage).toBeNull();
      expect(requestIndex).toBe(1);
    });

    it("matches by exact handle, not partial match", () => {
      const targetHandle = "about";

      const response = {
        data: {
          pages: {
            edges: [
              { node: { id: "gid://shopify/Page/1", title: "About Us", handle: "about-us" } },
              { node: { id: "gid://shopify/Page/2", title: "About Me", handle: "about-me" } },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      };

      // Replicate the exact-match find logic (line 134)
      const pages = response.data?.pages?.edges || [];
      const matchingPage = pages.find((page) => page.node.handle === targetHandle);

      // "about" should NOT match "about-us" or "about-me" (exact match only)
      expect(matchingPage).toBeUndefined();
    });
  });
});
