import { json } from "@remix-run/node";

/**
 * Fetch all navigation menus from production store
 * @param {string} productionStore - The production store domain
 * @param {string} accessToken - The production store access token
 * @returns {Promise<Array>} Array of navigation menus
 */
async function getProductionMenus(productionStore, accessToken) {
  const query = `
    query GetMenus {
      menus(first: 50) {
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
      }
    }
  `;

  const response = await fetch(
    `https://${productionStore}/admin/api/2025-01/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": accessToken,
      },
      body: JSON.stringify({ query }),
    },
  );

  const data = await response.json();

  if (data.errors) {
    console.error("Error fetching production menus:", data.errors);

    // Check for specific scope-related errors
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

  return data.data?.menus?.edges?.map((edge) => edge.node) || [];
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
      query: `handle:"${handle}"`,
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
    query GetPages($first: Int!) {
      pages(first: $first) {
        edges {
          node {
            id
            handle
          }
        }
      }
    }
  `;

  const response = await stagingAdmin.graphql(query, {
    variables: { first: 250 }, // Fetch up to 250 pages
  });
  const result = await response.json();

  if (result.errors) {
    console.error("Error getting staging page ID:", result.errors);
    return null;
  }

  const pages = result.data?.pages?.edges || [];
  // Filter pages by handle in JavaScript since GraphQL doesn't support query filtering for pages
  const matchingPage = pages.find((page) => page.node.handle === handle);
  return matchingPage ? matchingPage.node.id : null;
}

/**
 * Get staging collection ID by handle
 * @param {string} handle - The collection handle to search for
 * @param {Object} stagingAdmin - Shopify admin API client for staging
 * @returns {Promise<string|null>} The collection ID or null if not found
 */
async function getStagingCollectionIdByHandle(handle, stagingAdmin) {
  const query = `
    query GetCollections($first: Int!) {
      collections(first: $first) {
        edges {
          node {
            id
            handle
          }
        }
      }
    }
  `;
  const response = await stagingAdmin.graphql(query, {
    variables: { first: 250 }, // Fetch up to 250 collections
  });
  const result = await response.json();
  if (result.errors) {
    console.error("Error getting staging collection ID:", result.errors);
    return null;
  }
  const collections = result.data?.collections?.edges || [];
  // Filter collections by handle in JavaScript since GraphQL doesn't support query filtering for collections
  const matchingCollection = collections.find(
    (collection) => collection.node.handle === handle,
  );
  return matchingCollection ? matchingCollection.node.id : null;
}

/**
 * Get staging customer account page ID by handle
 * @param {string} handle - The customer account page handle to search for
 * @param {Object} stagingAdmin - Shopify admin API client for staging
 * @returns {Promise<string|null>} The customer account page ID or null if not found
 */
async function getStagingCustomerAccountPageIdByHandle(handle, stagingAdmin) {
  const query = `
    query GetCustomerAccountPages($first: Int!) {
      customerAccountPages(first: $first) {
        edges {
          node {
            id
            handle
          }
        }
      }
    }
  `;
  const response = await stagingAdmin.graphql(query, {
    variables: { first: 250 }, // Fetch up to 250 customer account pages
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
  // Filter pages by handle in JavaScript since GraphQL doesn't support query filtering for customer account pages
  const matchingPage = pages.find((page) => page.node.handle === handle);
  return matchingPage ? matchingPage.node.id : null;
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

  const variables = {
    id: menuId,
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

  const userErrors = result.data?.menuUpdate?.userErrors || [];
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
      let menuId;
      let isRestrictedHandle = false;

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
          menuId = existingMenu.id;
          summary.updated++;
          log.push({
            timestamp: new Date().toISOString(),
            message: `✅ Successfully updated menu: ${menu.title}`,
            success: true,
          });
        } else {
          // Check if the error is due to handle restrictions
          if (
            result.errors.includes("Handle can't be changed") ||
            result.errors.includes("default list")
          ) {
            isRestrictedHandle = true;
            log.push({
              timestamp: new Date().toISOString(),
              message: `Menu "${menu.title}" has restricted handle, creating new one: ${menu.title}`,
            });

            const newMenu = {
              ...menu,
              handle: `${menu.handle}-imported-${Date.now()}`,
            };

            result = await createMenuInStaging(newMenu, stagingAdmin);

            if (result.success) {
              menuId = result.menu.id;
              summary.created++;
              log.push({
                timestamp: new Date().toISOString(),
                message: `✅ Created new menu for restricted handle: ${menu.title} (handle: ${newMenu.handle})`,
                success: true,
              });

              // Log the new menu for manual configuration
              log.push({
                timestamp: new Date().toISOString(),
                message: `Restricted menu "${menu.handle}" imported as "${newMenu.handle}" (ID: ${menuId})`,
              });
            } else {
              summary.failed++;
              const errorMessage = `Failed to create new menu for restricted handle "${menu.title}" (handle: ${newMenu.handle}): ${result.errors}`;
              summary.errors.push(errorMessage);
              log.push({
                timestamp: new Date().toISOString(),
                message: `❌ ${errorMessage}`,
                success: false,
                error: result.errors,
              });
            }
          } else {
            // Regular update failure
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
        }
      } else {
        // Menu doesn't exist, create new one
        log.push({
          timestamp: new Date().toISOString(),
          message: `Creating new menu: ${menu.title}`,
        });

        result = await createMenuInStaging(menu, stagingAdmin);

        if (result.success) {
          menuId = result.menu.id;
          summary.created++;
          log.push({
            timestamp: new Date().toISOString(),
            message: `✅ Successfully created menu: ${menu.title}`,
            success: true,
          });
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
