/**
 * Page Sync Service
 * Syncs pages from production to staging store
 */

import { saveMapping, extractIdFromGid } from "./resource-mapping.server.js";

/**
 * Fetch all pages from production store
 * @param {string} productionStore - The production store domain
 * @param {string} accessToken - The production store access token
 * @returns {Promise<Array>} Array of pages
 */
async function getProductionPages(productionStore, accessToken) {
  const query = `
    query GetPages($first: Int!, $after: String) {
      pages(first: $first, after: $after) {
        edges {
          node {
            id
            title
            handle
            body
            isPublished
            publishedAt
            templateSuffix
            createdAt
            updatedAt
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  `;

  const allPages = [];
  let hasNextPage = true;
  let cursor = null;

  while (hasNextPage) {
    const response = await fetch(
      `https://${productionStore}/admin/api/2025-07/graphql.json`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": accessToken,
        },
        body: JSON.stringify({
          query,
          variables: { first: 250, after: cursor },
        }),
      },
    );

    const data = await response.json();

    if (data.errors) {
      console.error("Error fetching production pages:", data.errors);
      const scopeError = data.errors.find(
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
        `Failed to fetch production pages: ${data.errors
          .map((e) => e.message)
          .join(", ")}`,
      );
    }

    const edges = data.data?.pages?.edges || [];
    allPages.push(...edges.map((edge) => edge.node));

    hasNextPage = data.data?.pages?.pageInfo?.hasNextPage || false;
    cursor = data.data?.pages?.pageInfo?.endCursor || null;
  }

  return allPages;
}

/**
 * Check if a page exists in staging by handle
 * @param {string} handle - The page handle
 * @param {Object} stagingAdmin - Shopify admin API client for staging
 * @returns {Promise<Object|null>} The existing page or null
 */
async function getStagingPageByHandle(handle, stagingAdmin) {
  const query = `
    query GetPages($first: Int!, $after: String) {
      pages(first: $first, after: $after) {
        edges {
          node {
            id
            title
            handle
            body
            isPublished
            publishedAt
            templateSuffix
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  `;

  let hasNextPage = true;
  let cursor = null;

  while (hasNextPage) {
    const response = await stagingAdmin.graphql(query, {
      variables: { first: 250, after: cursor },
    });
    const result = await response.json();

    if (result.errors) {
      console.error("Error checking staging page:", result.errors);
      return null;
    }

    const pages = result.data?.pages?.edges || [];
    const matchingPage = pages.find((page) => page.node.handle === handle);
    if (matchingPage) {
      return matchingPage.node;
    }

    hasNextPage = result.data?.pages?.pageInfo?.hasNextPage || false;
    cursor = result.data?.pages?.pageInfo?.endCursor || null;
  }

  return null;
}

/**
 * Create a new page in staging
 * @param {Object} page - The page object from production
 * @param {Object} stagingAdmin - Shopify admin API client for staging
 * @returns {Promise<Object>} Result of the page creation
 */
async function createPageInStaging(page, stagingAdmin) {
  const mutation = `
    mutation CreatePage($title: String!, $handle: String!, $body: String!, $isPublished: Boolean, $templateSuffix: String) {
      pageCreate(page: {
        title: $title
        handle: $handle
        body: $body
        isPublished: $isPublished
        templateSuffix: $templateSuffix
      }) {
        page {
          id
          handle
          title
          isPublished
        }
        userErrors {
          field
          message
          code
        }
      }
    }
  `;

  const variables = {
    title: page.title,
    handle: page.handle,
    body: page.body,
    isPublished: page.isPublished,
    templateSuffix: page.templateSuffix,
  };

  const response = await stagingAdmin.graphql(mutation, { variables });
  const result = await response.json();

  if (result.errors) {
    return {
      success: false,
      errors: result.errors.map((e) => e.message).join(", "),
    };
  }

  const userErrors = result.data?.pageCreate?.userErrors || [];
  if (userErrors.length > 0) {
    return {
      success: false,
      errors: userErrors.map((e) => e.message).join(", "),
    };
  }

  const createdPage = result.data?.pageCreate?.page;
  if (createdPage) {
    return {
      success: true,
      page: createdPage,
    };
  }

  return {
    success: false,
    errors: "Unknown error creating page",
  };
}

/**
 * Update an existing page in staging
 * @param {string} pageId - The staging page ID
 * @param {Object} page - The page object from production
 * @param {Object} stagingAdmin - Shopify admin API client for staging
 * @returns {Promise<Object>} Result of the page update
 */
async function updatePageInStaging(pageId, page, stagingAdmin) {
  const mutation = `
    mutation UpdatePage($id: ID!, $page: PageUpdateInput!) {
      pageUpdate(id: $id, page: $page) {
        page {
          id
          handle
          title
          isPublished
        }
        userErrors {
          field
          message
          code
        }
      }
    }
  `;

  const variables = {
    id: pageId,
    page: {
      title: page.title,
      handle: page.handle,
      body: page.body,
      isPublished: page.isPublished,
      templateSuffix: page.templateSuffix,
    },
  };

  const response = await stagingAdmin.graphql(mutation, { variables });
  const result = await response.json();

  if (result.errors) {
    return {
      success: false,
      errors: result.errors.map((e) => e.message).join(", "),
    };
  }

  const userErrors = result.data?.pageUpdate?.userErrors || [];
  if (userErrors.length > 0) {
    return {
      success: false,
      errors: userErrors.map((e) => e.message).join(", "),
    };
  }

  const updatedPage = result.data?.pageUpdate?.page;
  if (updatedPage) {
    return {
      success: true,
      page: updatedPage,
    };
  }

  return {
    success: false,
    errors: "Unknown error updating page",
  };
}

/**
 * Sync pages from production to staging
 * @param {string} productionStore - The production store domain
 * @param {string} accessToken - The production store access token
 * @param {Object} stagingAdmin - Shopify admin API client for staging
 * @param {Function} onProgress - Progress callback function
 * @returns {Promise<Object>} Sync summary
 */
export async function syncPages(
  productionStore,
  accessToken,
  stagingAdmin,
  storeConnectionId = null,
  onProgress = () => {},
) {
  const log = [];
  const summary = {
    total: 0,
    created: 0,
    updated: 0,
    skipped: 0,
    failed: 0,
    errors: [],
  };

  try {
    // Step 1: Fetch all pages from production
    log.push({
      timestamp: new Date().toISOString(),
      message: "Fetching pages from production store...",
    });

    onProgress({
      stage: "fetching",
      message: "Fetching pages from production...",
      percentage: 0,
    });

    const productionPages = await getProductionPages(
      productionStore,
      accessToken,
    );

    console.log("productionPages", productionPages);

    summary.total = productionPages.length;

    // Step 2: Process each page (create or update)
    for (let i = 0; i < productionPages.length; i++) {
      const page = productionPages[i];
      const progress = Math.round(((i + 1) / productionPages.length) * 100);

      console.log("page", page);

      onProgress({
        stage: "processing",
        message: `Processing page: ${page.title}`,
        percentage: progress,
      });

      // Check if page exists in staging by handle
      const existingPage = await getStagingPageByHandle(
        page.handle,
        stagingAdmin,
      );

      console.log("existingPage", existingPage);

      if (existingPage) {
        // Update existing page
        log.push({
          timestamp: new Date().toISOString(),
          message: `Updating existing page: ${page.title} (${page.handle})`,
        });

        const result = await updatePageInStaging(
          existingPage.id,
          page,
          stagingAdmin,
        );

        console.log("result", result);

        if (result.success) {
          summary.updated++;
          log.push({
            timestamp: new Date().toISOString(),
            message: `✅ Successfully updated page: ${page.title}`,
          });

          // Save mapping for updated page
          if (storeConnectionId) {
            try {
              await saveMapping(storeConnectionId, "page", {
                productionId: extractIdFromGid(page.id),
                stagingId: extractIdFromGid(existingPage.id),
                productionGid: page.id,
                stagingGid: existingPage.id,
                matchKey: "handle",
                matchValue: page.handle,
                syncId: null,
                title: page.title,
              });
              console.log(`✅ Saved mapping for page: ${page.handle}`);
            } catch (mappingError) {
              console.error(
                `⚠️ Failed to save mapping for page ${page.handle}:`,
                mappingError.message,
              );
            }
          }
        } else {
          summary.failed++;
          log.push({
            timestamp: new Date().toISOString(),
            message: `❌ Failed to update page: ${page.title} - ${result.errors}`,
          });
          summary.errors.push(result.errors);
        }
      } else {
        console.log("creating new page");

        // Create new page
        log.push({
          timestamp: new Date().toISOString(),
          message: `Creating new page: ${page.title} (${page.handle})`,
        });

        const result = await createPageInStaging(page, stagingAdmin);

        console.log("result new created", result);

        if (result.success) {
          summary.created++;
          log.push({
            timestamp: new Date().toISOString(),
            message: `✅ Successfully created page: ${page.title}`,
          });

          // Save mapping for created page
          if (storeConnectionId) {
            try {
              await saveMapping(storeConnectionId, "page", {
                productionId: extractIdFromGid(page.id),
                stagingId: extractIdFromGid(result.page.id),
                productionGid: page.id,
                stagingGid: result.page.id,
                matchKey: "handle",
                matchValue: page.handle,
                syncId: null,
                title: page.title,
              });
              console.log(`✅ Saved mapping for page: ${page.handle}`);
            } catch (mappingError) {
              console.error(
                `⚠️ Failed to save mapping for page ${page.handle}:`,
                mappingError.message,
              );
            }
          }
        } else {
          summary.failed++;
          log.push({
            timestamp: new Date().toISOString(),
            message: `❌ Failed to create page: ${page.title} - ${result.errors}`,
          });
          summary.errors.push(result.errors);
        }
      }
    }

    // Step 3: Complete
    onProgress({
      stage: "complete",
      message: `Page sync completed. Created: ${summary.created}, Updated: ${summary.updated}, Failed: ${summary.failed}`,
      percentage: 100,
    });

    log.push({
      timestamp: new Date().toISOString(),
      message: `Page sync completed. Total: ${summary.total}, Created: ${summary.created}, Updated: ${summary.updated}, Failed: ${summary.failed}`,
    });
  } catch (error) {
    console.log("error", error);
    log.push({
      timestamp: new Date().toISOString(),
      message: `❌ Error during page sync: ${error.message}`,
    });
    summary.errors.push(error.message);
  }

  return { summary, log };
}
