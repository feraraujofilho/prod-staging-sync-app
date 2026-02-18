import { saveMapping, extractIdFromGid } from "./resource-mapping.server.js";

/**
 * Fetch all image files from production store
 * @param {string} productionStore - The production store domain
 * @param {string} accessToken - The production store access token
 * @returns {Promise<Array>} Array of image files
 */
async function getProductionImageFiles(productionStore, accessToken) {
  const files = [];
  let hasNextPage = true;
  let cursor = null;

  while (hasNextPage) {
    const query = `
      query GetImageFiles($cursor: String) {
        files(
          first: 50
          after: $cursor
          query: "media_type:IMAGE"
        ) {
          edges {
            node {
              ... on MediaImage {
                id
                alt
                createdAt
                fileStatus
                image {
                  url
                  width
                  height
                }
              }
            }
            cursor
          }
          pageInfo {
            hasNextPage
          }
        }
      }
    `;

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
          variables: { cursor },
        }),
      },
    );

    const data = await response.json();

    if (data.errors) {
      console.error("Error fetching production files:", data.errors);
      throw new Error("Failed to fetch production files");
    }

    const edges = data.data?.files?.edges || [];

    // Filter out product images and only keep theme/files uploads
    // Product images typically have specific patterns in their URLs
    for (const edge of edges) {
      const file = edge.node;
      if (file && file.image?.url) {
        // Skip if it's a product image (contains /products/ in the path)
        if (!file.image.url.includes("/products/")) {
          files.push(file);
        }
      }
    }

    hasNextPage = data.data?.files?.pageInfo?.hasNextPage || false;
    cursor = edges.length > 0 ? edges[edges.length - 1].cursor : null;
  }

  return files;
}

/**
 * Check if a file already exists in staging by filename
 * @param {string} filename - The filename to check
 * @param {Object} stagingAdmin - Shopify admin API client for staging
 * @returns {Promise<boolean>} Whether the file exists
 */
async function fileExistsInStaging(filename, stagingAdmin) {
  const query = `
    query CheckFileExists($query: String!) {
      files(first: 1, query: $query) {
        edges {
          node {
            ... on MediaImage {
              id
              image {
                url
              }
            }
          }
        }
      }
    }
  `;

  const response = await stagingAdmin.graphql(query, {
    variables: {
      query: `filename:"${filename}"`,
    },
  });

  const data = await response.json();
  const file = data.data?.files?.edges?.[0]?.node;
  return file || false;
}

/**
 * Extract filename from URL
 * @param {string} url - The file URL
 * @returns {string} The filename
 */
function extractFilenameFromUrl(url) {
  try {
    const urlObj = new URL(url);
    const pathname = urlObj.pathname;
    const parts = pathname.split("/");
    return parts[parts.length - 1] || "unknown-file";
  } catch (error) {
    console.error("Error extracting filename:", error);
    return "unknown-file";
  }
}

/**
 * Create an image file in staging
 * @param {Object} file - The file object from production
 * @param {Object} stagingAdmin - Shopify admin API client for staging
 * @returns {Promise<Object>} Result of the file creation
 */
async function createFileInStaging(file, stagingAdmin) {
  const filename = extractFilenameFromUrl(file.image.url);

  const mutation = `
    mutation CreateFile($files: [FileCreateInput!]!) {
      fileCreate(files: $files) {
        files {
          id
          fileStatus
          alt
          createdAt
          ... on MediaImage {
            image {
              width
              height
              url
            }
          }
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
    files: [
      {
        alt: file.alt || "",
        contentType: "IMAGE",
        originalSource: file.image.url,
        filename: filename,
        duplicateResolutionMode: "RAISE_ERROR", // Raises error on duplicate so we can detect and skip
      },
    ],
  };

  const response = await stagingAdmin.graphql(mutation, { variables });
  const result = await response.json();

  if (result.errors) {
    return {
      success: false,
      errors: result.errors.map((e) => e.message).join(", "),
    };
  }

  const userErrors = result.data?.fileCreate?.userErrors || [];
  if (userErrors.length > 0) {
    // Check if it's a duplicate filename error
    const isDuplicate = userErrors.some(
      (e) =>
        e.code === "FILENAME_ALREADY_EXISTS" ||
        e.message.includes("already exists"),
    );

    if (isDuplicate) {
      return {
        success: false,
        skipped: true,
        errors: "File with same name already exists",
      };
    }

    return {
      success: false,
      errors: userErrors.map((e) => e.message).join(", "),
    };
  }

  const createdFiles = result.data?.fileCreate?.files || [];
  if (createdFiles.length > 0) {
    return {
      success: true,
      file: createdFiles[0],
    };
  }

  return {
    success: false,
    errors: "Unknown error creating file",
  };
}

/**
 * Wait for file to be processed
 * @param {string} fileId - The file ID to check
 * @param {Object} stagingAdmin - Shopify admin API client
 * @param {number} maxAttempts - Maximum number of polling attempts
 * @returns {Promise<string>} The file status
 */
async function waitForFileProcessing(fileId, stagingAdmin, maxAttempts = 10) {
  const query = `
    query GetFileStatus($id: ID!) {
      node(id: $id) {
        ... on File {
          fileStatus
        }
      }
    }
  `;

  for (let i = 0; i < maxAttempts; i++) {
    const response = await stagingAdmin.graphql(query, {
      variables: { id: fileId },
    });

    const data = await response.json();
    const status = data.data?.node?.fileStatus;

    if (status === "READY" || status === "FAILED") {
      return status;
    }

    // Wait 2 seconds before next attempt
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  return "TIMEOUT";
}

/**
 * Sync image files from production to staging
 * @param {string} productionStore - The production store domain
 * @param {string} accessToken - The production store access token
 * @param {Object} stagingAdmin - Shopify admin API client for staging
 * @param {Function} onProgress - Progress callback function
 * @returns {Promise<Object>} Sync summary
 */
export async function syncImageFiles(
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
    skipped: 0,
    failed: 0,
    errors: [],
  };

  try {
    // Step 1: Fetch all image files from production
    log.push({
      timestamp: new Date().toISOString(),
      message: "Fetching image files from production store...",
    });

    onProgress({
      stage: "fetching",
      message: "Fetching image files from production...",
      percentage: 0,
    });

    const productionFiles = await getProductionImageFiles(
      productionStore,
      accessToken,
    );

    summary.total = productionFiles.length;

    log.push({
      timestamp: new Date().toISOString(),
      message: `Found ${productionFiles.length} image files (excluding product images)`,
    });

    if (productionFiles.length === 0) {
      return { summary, log };
    }

    // Step 2: Process each file
    for (let i = 0; i < productionFiles.length; i++) {
      const file = productionFiles[i];
      const filename = extractFilenameFromUrl(file.image.url);
      const progress = Math.round(((i + 1) / productionFiles.length) * 100);

      onProgress({
        stage: "syncing",
        message: `Processing ${filename} (${i + 1}/${productionFiles.length})`,
        percentage: progress,
        current: i + 1,
        total: productionFiles.length,
      });

      log.push({
        timestamp: new Date().toISOString(),
        message: `Processing file: ${filename}`,
      });

      // Check if file already exists
      const existingFile = await fileExistsInStaging(filename, stagingAdmin);

      if (existingFile) {
        summary.skipped++;
        log.push({
          timestamp: new Date().toISOString(),
          message: `⚠️ Skipped ${filename} - already exists in staging`,
          skipped: true,
        });

        // Save mapping for existing file
        if (storeConnectionId && existingFile.id) {
          try {
            await saveMapping(storeConnectionId, "file", {
              productionId: extractIdFromGid(file.id),
              stagingId: extractIdFromGid(existingFile.id),
              productionGid: file.id,
              stagingGid: existingFile.id,
              matchKey: "filename",
              matchValue: filename,
              syncId: null,
              title: filename,
            });
            console.log(`✅ Saved mapping for existing file: ${filename}`);
          } catch (mappingError) {
            console.error(
              `⚠️ Failed to save mapping for existing file ${filename}:`,
              mappingError.message,
            );
          }
        }
        continue;
      }

      // Create file in staging
      const result = await createFileInStaging(file, stagingAdmin);

      if (result.success) {
        // Wait for file processing
        const status = await waitForFileProcessing(
          result.file.id,
          stagingAdmin,
        );

        if (status === "READY") {
          summary.created++;
          log.push({
            timestamp: new Date().toISOString(),
            message: `✅ Successfully created: ${filename}`,
            success: true,
          });

          // Save mapping for created file
          if (storeConnectionId) {
            try {
              await saveMapping(storeConnectionId, "file", {
                productionId: extractIdFromGid(file.id),
                stagingId: extractIdFromGid(result.file.id),
                productionGid: file.id,
                stagingGid: result.file.id,
                matchKey: "filename",
                matchValue: filename,
                syncId: null,
                title: filename,
              });
              console.log(`✅ Saved mapping for file: ${filename}`);
            } catch (mappingError) {
              console.error(
                `⚠️ Failed to save mapping for file ${filename}:`,
                mappingError.message,
              );
            }
          }
        } else {
          summary.failed++;
          log.push({
            timestamp: new Date().toISOString(),
            message: `❌ Failed to process ${filename}: File status ${status}`,
            success: false,
          });
        }
      } else if (result.skipped) {
        summary.skipped++;
        log.push({
          timestamp: new Date().toISOString(),
          message: `⚠️ Skipped ${filename} - ${result.errors}`,
          skipped: true,
        });
      } else {
        summary.failed++;
        summary.errors.push(`${filename}: ${result.errors}`);
        log.push({
          timestamp: new Date().toISOString(),
          message: `❌ Failed to create ${filename}: ${result.errors}`,
          success: false,
          error: result.errors,
        });
      }
    }

    onProgress({
      stage: "complete",
      message: "Sync completed",
      percentage: 100,
    });
  } catch (error) {
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
