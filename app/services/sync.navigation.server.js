/**
 * Fetch all navigation menus from production store
 * @param {string} productionStore - The production store domain
 * @param {string} accessToken - The production store access token
 * @returns {Promise<Array>} Array of navigation menus
 */

import { saveMapping, extractIdFromGid } from "./resource-mapping.server.js";
async function getProductionMenus(productionStore, accessToken) {
  const query = `
    query GetMenus($first: Int!, $after: String) {
      menus(first: $first, after: $after) {
        edges {
          node {
            id
            handle
            title
            isDefault
            items(limit: 100) {
              id
              title
              type
              url
              resourceId
              tags
              items {
                id
                title
                type
                url
                resourceId
                tags
                items {
                  id
                  title
                  type
                  url
                  resourceId
                  tags
                }
              }
            }
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  `;

  const allMenus = [];
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
          variables: { first: 50, after: cursor },
        }),
      },
    );

    const data = await response.json();

    if (data.errors) {
      console.error("Error fetching production menus:", data.errors);

      const scopeError = data.errors.find(
        (error) =>
          error.message.includes("Access denied") ||
          error.message.includes("menus field"),
      );

      if (scopeError) {
        throw new Error(
          "Access denied for menus. Please ensure the app has 'read_online_store_navigation' scope and reinstall the app if needed.",
        );
      }

      throw new Error(
        `Failed to fetch production menus: ${data.errors.map((e) => e.message).join(", ")}`,
      );
    }

    const edges = data.data?.menus?.edges || [];
    allMenus.push(...edges.map((edge) => edge.node));

    hasNextPage = data.data?.menus?.pageInfo?.hasNextPage || false;
    cursor = data.data?.menus?.pageInfo?.endCursor || null;
  }

  return allMenus;
}

/**
 * Check if a menu already exists in staging by handle
 * @param {string} handle - The menu handle to check
 * @param {Object} stagingAdmin - Shopify admin API client for staging
 * @returns {Promise<Object|null>} The existing menu or null
 */
async function getStagingMenuByHandle(handle, stagingAdmin) {
  const query = `
    query GetMenus($query: String!) {
      menus(first: 1, query: $query) {
        edges {
          node {
            id
            handle
            title
            isDefault
          }
        }
      }
    }
  `;

  const response = await stagingAdmin.graphql(query, {
    variables: {
      query: `handle:"${handle.replace(/"/g, '\\"')}"`,
    },
  });

  const data = await response.json();
  return data.data?.menus?.edges?.[0]?.node || null;
}

/**
 * Get staging page ID by handle
 * @param {string} handle - The page handle
 * @param {Object} stagingAdmin - Shopify admin API client for staging
 * @returns {Promise<string|null>} The staging page ID or null
 */
async function getStagingPageIdByHandle(handle, stagingAdmin) {
  const query = `
    query GetPages($first: Int!, $after: String) {
      pages(first: $first, after: $after) {
        edges {
          node {
            id
            handle
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
      console.error("Error getting staging page ID:", result.errors);
      return null;
    }

    const pages = result.data?.pages?.edges || [];
    const matchingPage = pages.find((page) => page.node.handle === handle);
    if (matchingPage) {
      return matchingPage.node.id;
    }

    hasNextPage = result.data?.pages?.pageInfo?.hasNextPage || false;
    cursor = result.data?.pages?.pageInfo?.endCursor || null;
  }

  return null;
}

/**
 * Get staging collection ID by handle
 * @param {string} handle - The collection handle to search for
 * @param {Object} stagingAdmin - Shopify admin API client for staging
 * @returns {Promise<string|null>} The collection ID or null if not found
 */
async function getStagingCollectionIdByHandle(handle, stagingAdmin) {
  const query = `
    query GetCollections($first: Int!, $after: String) {
      collections(first: $first, after: $after) {
        edges {
          node {
            id
            handle
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
      console.error("Error getting staging collection ID:", result.errors);
      return null;
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
  }

  return null;
}

/**
 * Get staging customer account page ID by handle
 * @param {string} handle - The customer account page handle to search for
 * @param {Object} stagingAdmin - Shopify admin API client for staging
 * @returns {Promise<string|null>} The customer account page ID or null if not found
 */
async function getStagingCustomerAccountPageIdByHandle(handle, stagingAdmin) {
  const query = `
    query GetCustomerAccountPages($first: Int!, $after: String) {
      customerAccountPages(first: $first, after: $after) {
        edges {
          node {
            id
            handle
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
      console.error(
        "Error getting staging customer account page ID:",
        result.errors,
      );
      return null;
    }
    const pages = result.data?.customerAccountPages?.edges || [];
    const matchingPage = pages.find((page) => page.node.handle === handle);
    if (matchingPage) {
      return matchingPage.node.id;
    }

    hasNextPage = result.data?.customerAccountPages?.pageInfo?.hasNextPage || false;
    cursor = result.data?.customerAccountPages?.pageInfo?.endCursor || null;
  }

  return null;
}

/**
 * Recursively process menu items to handle nested structure and page references
 * @param {Array} items - Array of menu items
 * @param {Object} stagingAdmin - Shopify admin API client for staging
 * @returns {Promise<Array>} Processed menu items
 */
async function processMenuItems(items, stagingAdmin) {
  if (!items || !Array.isArray(items)) return [];

  const processedItems = [];

  for (const item of items) {
    const processedItem = {
      title: item.title,
      type: item.type,
      url: item.url || null,
      resourceId: item.resourceId || null,
      tags: item.tags || [],
    };

    // Handle page references - if item type is PAGE and has a resourceId
    if (item.type === "PAGE" && item.resourceId) {
      // Extract handle from the production page GID
      const productionPageId = item.resourceId;
      const handleMatch = productionPageId.match(/\/Page\/(\d+)/);

      if (handleMatch) {
        // For now, we'll use the same handle pattern
        // In a more sophisticated approach, you might want to maintain a mapping
        // between production and staging page IDs
        const pageId = handleMatch[1];

        // Try to find the corresponding page in staging by handle
        // This assumes the page was already synced with the same handle
        const stagingPageId = await getStagingPageIdByHandle(
          item.url?.split("/").pop() || `page-${pageId}`,
          stagingAdmin,
        );

        if (stagingPageId) {
          processedItem.resourceId = stagingPageId;
          console.log(
            `Mapped page reference: ${productionPageId} -> ${stagingPageId}`,
          );
        } else {
          console.log(
            `Warning: Could not find staging page for production page ${productionPageId}`,
          );
          // Remove the resourceId to avoid errors
          processedItem.resourceId = null;
        }
      }
    }

    // Handle customer account page references - if item type is CUSTOMER_ACCOUNT_PAGE and has a resourceId
    if (item.type === "CUSTOMER_ACCOUNT_PAGE" && item.resourceId) {
      // Extract handle from the production customer account page GID
      const productionPageId = item.resourceId;
      const handleMatch = productionPageId.match(
        /\/CustomerAccountPage\/(\d+)/,
      );

      if (handleMatch) {
        // Try to find the corresponding customer account page in staging by handle
        const stagingPageId = await getStagingCustomerAccountPageIdByHandle(
          item.url?.split("/").pop() ||
            `customer-account-page-${handleMatch[1]}`,
          stagingAdmin,
        );

        if (stagingPageId) {
          processedItem.resourceId = stagingPageId;
          console.log(
            `Mapped customer account page reference: ${productionPageId} -> ${stagingPageId}`,
          );
        } else {
          console.log(
            `Warning: Could not find staging customer account page for production page ${productionPageId}`,
          );
          // For customer account pages that don't exist in staging, convert to URL type
          processedItem.type = "HTTP";
          processedItem.url =
            item.url ||
            `/account/${item.url?.split("/").pop() || `page-${handleMatch[1]}`}`;
          processedItem.resourceId = null;
          console.log(
            `Converted customer account page item to HTTP: ${item.title} -> ${processedItem.url}`,
          );
        }
      }
    }

    // Handle collection references - if item type is COLLECTION and has a resourceId
    if (item.type === "COLLECTION" && item.resourceId) {
      // Extract handle from the production collection GID
      const productionCollectionId = item.resourceId;
      const handleMatch = productionCollectionId.match(/\/Collection\/(\d+)/);

      if (handleMatch) {
        // Try to find the corresponding collection in staging by handle
        const stagingCollectionId = await getStagingCollectionIdByHandle(
          item.url?.split("/").pop() || `collection-${handleMatch[1]}`,
          stagingAdmin,
        );

        if (stagingCollectionId) {
          processedItem.resourceId = stagingCollectionId;
          console.log(
            `Mapped collection reference: ${productionCollectionId} -> ${stagingCollectionId}`,
          );
        } else {
          console.log(
            `Warning: Could not find staging collection for production collection ${productionCollectionId}`,
          );
          // For collection items that don't exist in staging, convert to HTTP type
          // This prevents the menu creation from failing
          processedItem.type = "HTTP";
          processedItem.url =
            item.url ||
            `/collections/${item.url?.split("/").pop() || `collection-${handleMatch[1]}`}`;
          processedItem.resourceId = null;
          console.log(
            `Converted collection item to HTTP: ${item.title} -> ${processedItem.url}`,
          );
        }
      }
    }

    // Handle nested items (up to 3 levels deep)
    if (item.items && Array.isArray(item.items) && item.items.length > 0) {
      processedItem.items = await processMenuItems(item.items, stagingAdmin);
    }

    processedItems.push(processedItem);
  }

  return processedItems;
}

/**
 * Create a navigation menu in staging
 * @param {Object} menu - The menu object from production
 * @param {Object} stagingAdmin - Shopify admin API client for staging
 * @returns {Promise<Object>} Result of the menu creation
 */
async function createMenuInStaging(menu, stagingAdmin) {
  const mutation = `
    mutation CreateMenu($title: String!, $handle: String!, $items: [MenuItemCreateInput!]!) {
      menuCreate(title: $title, handle: $handle, items: $items) {
        menu {
          id
          handle
          title
          isDefault
        }
        userErrors {
          field
          message
          code
        }
      }
    }
  `;

  const processedItems = await processMenuItems(menu.items, stagingAdmin);

  // Log menu item processing for debugging
  console.log(
    `Processing menu "${menu.title}" with ${processedItems.length} items`,
  );
  if (processedItems.length > 0) {
    processedItems.forEach((item, index) => {
      console.log(`  Item ${index + 1}: ${item.title} (type: ${item.type})`);
    });
  }

  const variables = {
    title: menu.title,
    handle: menu.handle,
    items: processedItems,
  };

  const response = await stagingAdmin.graphql(mutation, { variables });
  const result = await response.json();

  if (result.errors) {
    return {
      success: false,
      errors: result.errors.map((e) => e.message).join(", "),
    };
  }

  const userErrors = result.data?.menuCreate?.userErrors || [];
  if (userErrors.length > 0) {
    const detailedErrors = userErrors
      .map((e) => {
        if (e.field) {
          return `${e.field}: ${e.message}${e.code ? ` (${e.code})` : ""}`;
        }
        return e.message;
      })
      .join(", ");

    return {
      success: false,
      errors: detailedErrors,
    };
  }

  const createdMenu = result.data?.menuCreate?.menu;
  if (createdMenu) {
    return {
      success: true,
      menu: createdMenu,
    };
  }

  return {
    success: false,
    errors: "Unknown error creating menu",
  };
}

/**
 * Update an existing navigation menu in staging
 * @param {string} menuId - The staging menu ID
 * @param {Object} menu - The menu object from production
 * @param {Object} stagingAdmin - Shopify admin API client for staging
 * @returns {Promise<Object>} Result of the menu update
 */
async function updateMenuInStaging(menuId, menu, stagingAdmin) {
  const mutation = `
    mutation UpdateMenu($id: ID!, $title: String!, $handle: String, $items: [MenuItemUpdateInput!]!) {
      menuUpdate(id: $id, title: $title, handle: $handle, items: $items) {
        menu {
          id
          handle
          title
          isDefault
        }
        userErrors {
          field
          message
          code
        }
      }
    }
  `;

  const processedItems = await processMenuItems(menu.items, stagingAdmin);

  // Log menu item processing for debugging
  console.log(
    `Updating menu "${menu.title}" with ${processedItems.length} items`,
  );
  if (processedItems.length > 0) {
    processedItems.forEach((item, index) => {
      console.log(`  Item ${index + 1}: ${item.title} (type: ${item.type})`);
    });
  }

  // For default menus, omit handle to avoid "Handle can't be changed/default list" errors
  const baseVariables = {
    id: menuId,
    title: menu.title,
    items: processedItems,
  };
  const includeHandle = !menu.isDefault;
  const variables = includeHandle
    ? { ...baseVariables, handle: menu.handle }
    : baseVariables;

  let response = await stagingAdmin.graphql(mutation, { variables });
  const result = await response.json();

  if (result.errors) {
    return {
      success: false,
      errors: result.errors.map((e) => e.message).join(", "),
    };
  }

  const userErrors = result.data?.menuUpdate?.userErrors || [];
  if (userErrors.length > 0) {
    const messages = userErrors.map((e) => e.message);
    const handleProblem =
      includeHandle &&
      (messages.some((m) => m.includes("Handle can't be changed")) ||
        messages.some((m) => m.includes("default list")));

    // Retry once without handle if we hit a handle restriction
    if (handleProblem) {
      console.log(
        `Menu update encountered handle restriction for "${menu.title}". Retrying without handle...`,
      );
      response = await stagingAdmin.graphql(mutation, {
        variables: baseVariables,
      });
      const retryResult = await response.json();
      if (retryResult.errors) {
        return {
          success: false,
          errors: retryResult.errors.map((e) => e.message).join(", "),
        };
      }
      const retryErrors = retryResult.data?.menuUpdate?.userErrors || [];
      if (retryErrors.length === 0 && retryResult.data?.menuUpdate?.menu) {
        return { success: true, menu: retryResult.data.menuUpdate.menu };
      }
      const retryDetailed = retryErrors
        .map((e) =>
          e.field
            ? `${e.field}: ${e.message}${e.code ? ` (${e.code})` : ""}`
            : e.message,
        )
        .join(", ");
      return { success: false, errors: retryDetailed };
    }

    const detailedErrors = userErrors
      .map((e) =>
        e.field
          ? `${e.field}: ${e.message}${e.code ? ` (${e.code})` : ""}`
          : e.message,
      )
      .join(", ");

    return { success: false, errors: detailedErrors };
  }

  const updatedMenu = result.data?.menuUpdate?.menu;
  if (updatedMenu) {
    return {
      success: true,
      menu: updatedMenu,
    };
  }

  return {
    success: false,
    errors: "Unknown error updating menu",
  };
}

/**
 * Sync navigation menus from production to staging
 * @param {string} productionStore - The production store domain
 * @param {string} accessToken - The production store access token
 * @param {Object} stagingAdmin - Shopify admin API client for staging
 * @param {Function} onProgress - Progress callback function
 * @returns {Promise<Object>} Sync summary
 */
export async function syncNavigationMenus(
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
    // Step 1: Fetch all navigation menus from production
    log.push({
      timestamp: new Date().toISOString(),
      message: "Fetching navigation menus from production store...",
    });

    onProgress({
      stage: "fetching",
      message: "Fetching navigation menus from production...",
      percentage: 0,
    });

    const productionMenus = await getProductionMenus(
      productionStore,
      accessToken,
    );

    console.log("productionMenus", productionMenus);

    summary.total = productionMenus.length;

    log.push({
      timestamp: new Date().toISOString(),
      message: `Found ${productionMenus.length} navigation menus`,
    });

    if (productionMenus.length === 0) {
      return { summary, log };
    }

    // Step 2: Process each menu
    for (let i = 0; i < productionMenus.length; i++) {
      const menu = productionMenus[i];
      const progress = Math.round(((i + 1) / productionMenus.length) * 100);

      console.log("menu", menu);

      onProgress({
        stage: "syncing",
        message: `Processing menu: ${menu.title} (${i + 1}/${productionMenus.length})`,
        percentage: progress,
        current: i + 1,
        total: productionMenus.length,
      });

      log.push({
        timestamp: new Date().toISOString(),
        message: `Processing menu: ${menu.title} (handle: ${menu.handle})`,
      });

      // Track default menus for later configuration
      const isDefaultMenu = menu.isDefault;

      if (isDefaultMenu) {
        log.push({
          timestamp: new Date().toISOString(),
          message: `Processing default menu: ${menu.title} (handle: ${menu.handle})`,
        });
      }

      // Try to update or create the menu, handling restricted handles dynamically
      let result;

      // Check if menu already exists in staging
      const existingMenu = await getStagingMenuByHandle(
        menu.handle,
        stagingAdmin,
      );

      if (existingMenu) {
        // Try to update existing menu
        log.push({
          timestamp: new Date().toISOString(),
          message: `Attempting to update menu: ${menu.title}`,
        });

        result = await updateMenuInStaging(existingMenu.id, menu, stagingAdmin);

        if (result.success) {
          summary.updated++;
          log.push({
            timestamp: new Date().toISOString(),
            message: `✅ Successfully updated menu: ${menu.title}`,
            success: true,
          });

          // Save mapping for updated menu
          if (storeConnectionId) {
            try {
              await saveMapping(storeConnectionId, "navigation", {
                productionId: extractIdFromGid(menu.id),
                stagingId: extractIdFromGid(existingMenu.id),
                productionGid: menu.id,
                stagingGid: existingMenu.id,
                matchKey: "handle",
                matchValue: menu.handle,
                syncId: null,
                title: menu.title,
              });
              console.log(`✅ Saved mapping for menu: ${menu.handle}`);
            } catch (mappingError) {
              console.error(
                `⚠️ Failed to save mapping for menu ${menu.handle}:`,
                mappingError.message,
              );
            }
          }
        } else {
          // Update failure (already retried without handle inside updater when applicable)
          summary.failed++;
          const errorMessage = `Failed to update menu "${menu.title}" (handle: ${menu.handle}): ${result.errors}`;
          summary.errors.push(errorMessage);
          log.push({
            timestamp: new Date().toISOString(),
            message: `❌ ${errorMessage}`,
            success: false,
            error: result.errors,
          });
        }
      } else {
        // Menu doesn't exist, create new one
        log.push({
          timestamp: new Date().toISOString(),
          message: `Creating new menu: ${menu.title}`,
        });

        result = await createMenuInStaging(menu, stagingAdmin);

        if (result.success) {
          summary.created++;
          log.push({
            timestamp: new Date().toISOString(),
            message: `✅ Successfully created menu: ${menu.title}`,
            success: true,
          });

          // Save mapping for created menu
          if (storeConnectionId) {
            try {
              await saveMapping(storeConnectionId, "navigation", {
                productionId: extractIdFromGid(menu.id),
                stagingId: extractIdFromGid(result.menu.id),
                productionGid: menu.id,
                stagingGid: result.menu.id,
                matchKey: "handle",
                matchValue: menu.handle,
                syncId: null,
                title: menu.title,
              });
              console.log(`✅ Saved mapping for menu: ${menu.handle}`);
            } catch (mappingError) {
              console.error(
                `⚠️ Failed to save mapping for menu ${menu.handle}:`,
                mappingError.message,
              );
            }
          }
        } else {
          summary.failed++;
          const errorMessage = `Failed to create menu "${menu.title}" (handle: ${menu.handle}): ${result.errors}`;
          summary.errors.push(errorMessage);
          log.push({
            timestamp: new Date().toISOString(),
            message: `❌ ${errorMessage}`,
            success: false,
            error: result.errors,
          });
        }
      }
    }

    // Step 3: Add final note about manual configuration
    log.push({
      timestamp: new Date().toISOString(),
      message:
        "Note: Default menu configuration must be set manually in theme settings",
    });

    onProgress({
      stage: "complete",
      message: "Sync completed",
      percentage: 100,
    });
  } catch (error) {
    console.log("error", error);
    log.push({
      timestamp: new Date().toISOString(),
      message: `❌ Sync failed: ${error.message}`,
      success: false,
      error: error.message,
    });
    summary.errors.push(error.message);
  }

  return { summary, log };
}
