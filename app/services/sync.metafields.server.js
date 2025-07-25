// Service for syncing metafield definitions between stores

// Get metafield definitions from external store
async function getMetafieldDefinitions(ownerType, store, token) {
  const query = `
    query GetMetafieldDefinitions($ownerType: MetafieldOwnerType!, $cursor: String) {
      metafieldDefinitions(ownerType: $ownerType, first: 250, after: $cursor) {
        edges {
          node {
            id
            namespace
            key
            name
            type {
              name
            }
            description
            ownerType
            validations {
              name
              value
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

  const definitions = [];
  let hasNextPage = true;
  let cursor = null;

  while (hasNextPage) {
    try {
      const response = await fetch(
        `https://${store}/admin/api/2025-01/graphql.json`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Shopify-Access-Token": token,
          },
          body: JSON.stringify({ query, variables: { ownerType, cursor } }),
        },
      );

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data = await response.json();

      if (data.errors) {
        throw new Error(
          `GraphQL errors: ${data.errors.map((e) => e.message).join(", ")}`,
        );
      }

      const edges = data.data.metafieldDefinitions.edges;
      definitions.push(...edges.map((edge) => edge.node));

      hasNextPage = data.data.metafieldDefinitions.pageInfo.hasNextPage;
      cursor = edges.length > 0 ? edges[edges.length - 1].cursor : null;
    } catch (error) {
      console.error("Error fetching metafield definitions:", error);
      throw error;
    }
  }

  return definitions;
}

// Get existing metafield definitions in staging
async function getExistingStagingDefinitions(ownerType, stagingAdmin) {
  const query = `
    query GetMetafieldDefinitions($ownerType: MetafieldOwnerType!) {
      metafieldDefinitions(ownerType: $ownerType, first: 250) {
        edges {
          node {
            id
            namespace
            key
            type {
              name
            }
          }
        }
      }
    }
  `;

  try {
    const response = await stagingAdmin.graphql(query, {
      variables: { ownerType },
    });

    const data = await response.json();
    console.log("Staging definitions response:", JSON.stringify(data, null, 2));

    if (data.errors) {
      throw new Error(
        `GraphQL errors: ${data.errors.map((e) => e.message).join(", ")}`,
      );
    }

    return data.data.metafieldDefinitions.edges.map((edge) => edge.node);
  } catch (error) {
    console.error("Error fetching staging definitions:", error);
    return [];
  }
}

// Create a metafield definition in staging
async function createMetafieldDefinition(definition, stagingAdmin) {
  const mutation = `
    mutation CreateMetafieldDefinition($definition: MetafieldDefinitionInput!) {
      metafieldDefinitionCreate(definition: $definition) {
        createdDefinition {
          id
          namespace
          key
          type {
            name
          }
          description
          ownerType
        }
        userErrors {
          field
          message
          code
        }
      }
    }
  `;

  // Prepare the input - remove the 'id' field as it's not needed for creation
  const definitionInput = {
    name: definition.key, // Using key as name if name is not available
    namespace: definition.namespace,
    key: definition.key,
    description:
      definition.description ||
      `Synced from production: ${definition.namespace}.${definition.key}`,
    type: definition.type.name,
    ownerType: definition.ownerType,
  };

  try {
    console.log(
      "Creating definition with input:",
      JSON.stringify(definitionInput, null, 2),
    );

    const response = await stagingAdmin.graphql(mutation, {
      variables: { definition: definitionInput },
    });

    const data = await response.json();
    console.log("Response data:", JSON.stringify(data, null, 2));

    // Check for GraphQL errors in the response
    if (data.errors) {
      console.error("GraphQL errors:", JSON.stringify(data.errors, null, 2));
      return {
        success: false,
        errors: data.errors.map((e) => e.message).join(", "),
      };
    }

    // Check if the mutation returned null (which usually means an error)
    if (!data.data || !data.data.metafieldDefinitionCreate) {
      console.error(
        "Mutation returned null. Full response:",
        JSON.stringify(data, null, 2),
      );
      return {
        success: false,
        errors: "Mutation failed - no data returned",
      };
    }

    // Check for user errors
    if (
      data.data.metafieldDefinitionCreate.userErrors &&
      data.data.metafieldDefinitionCreate.userErrors.length > 0
    ) {
      return {
        success: false,
        errors: data.data.metafieldDefinitionCreate.userErrors
          .map((e) => `${e.field}: ${e.message} (${e.code})`)
          .join(", "),
      };
    }

    return {
      success: true,
      definition: data.data.metafieldDefinitionCreate.createdDefinition,
    };
  } catch (error) {
    console.error("=== Error creating metafield definition ===");
    console.error("Error type:", error.constructor.name);
    console.error("Error message:", error.message);
    console.error("Error stack:", error.stack);

    // Log all error properties
    console.error("All error properties:", Object.keys(error));
    console.error("Full error object:", JSON.stringify(error, null, 2));

    // Check if this is a Shopify GraphQL client error
    if (error.graphQLErrors) {
      console.error(
        "GraphQL errors from client:",
        JSON.stringify(error.graphQLErrors, null, 2),
      );
      return {
        success: false,
        errors: error.graphQLErrors.map((e) => e.message).join(", "),
      };
    }

    // Check for response property
    if (error.response) {
      console.error("Error response:", error.response);
      console.error("Error response status:", error.response?.status);
      console.error("Error response headers:", error.response?.headers);
    }

    // Check for extensions property (common in GraphQL errors)
    if (error.extensions) {
      console.error(
        "Error extensions:",
        JSON.stringify(error.extensions, null, 2),
      );
    }

    return {
      success: false,
      errors: error.message || "Unknown error occurred",
    };
  }
}

// Update a metafield definition to add validations
async function updateMetafieldDefinition(definition, stagingAdmin) {
  const mutation = `
    mutation UpdateMetafieldDefinition($definition: MetafieldDefinitionUpdateInput!) {
      metafieldDefinitionUpdate(definition: $definition) {
        metafieldDefinition {
          id
          namespace
          key
          name
        }
        userErrors {
          field
          message
          code
        }
      }
    }
  `;

  // First, get the metafield definition ID
  const getQuery = `
    query GetMetafieldDefinition($namespace: String!, $key: String!, $ownerType: MetafieldOwnerType!) {
      metafieldDefinitions(namespace: $namespace, key: $key, ownerType: $ownerType, first: 1) {
        edges {
          node {
            id
          }
        }
      }
    }
  `;

  try {
    const getResponse = await stagingAdmin.graphql(getQuery, {
      variables: {
        namespace: definition.namespace,
        key: definition.key,
        ownerType: definition.ownerType,
      },
    });

    const getData = await getResponse.json();
    const definitionId =
      getData.data?.metafieldDefinitions?.edges?.[0]?.node?.id;

    if (!definitionId) {
      return {
        success: false,
        errors: `Metafield definition ${definition.namespace}.${definition.key} not found`,
      };
    }

    const definitionInput = {
      id: definitionId,
      validations: definition.validations,
    };

    const response = await stagingAdmin.graphql(mutation, {
      variables: { definition: definitionInput },
    });

    const data = await response.json();

    if (data.errors) {
      return {
        success: false,
        errors: data.errors.map((e) => e.message).join(", "),
      };
    }

    if (
      data.data.metafieldDefinitionUpdate.userErrors &&
      data.data.metafieldDefinitionUpdate.userErrors.length > 0
    ) {
      return {
        success: false,
        errors: data.data.metafieldDefinitionUpdate.userErrors
          .map((e) => `${e.field}: ${e.message} (${e.code})`)
          .join(", "),
      };
    }

    return {
      success: true,
      definition: data.data.metafieldDefinitionUpdate.metafieldDefinition,
    };
  } catch (error) {
    console.error("Error in updateMetafieldDefinition:", error);
    return {
      success: false,
      errors: error.message || "Failed to update metafield definition",
    };
  }
}

// Main sync function
export async function syncMetafieldDefinitions(
  productionStore,
  accessToken,
  stagingAdmin,
) {
  const log = [];

  try {
    // Step 1: Fetch product metafield definitions from production
    log.push({
      timestamp: new Date().toISOString(),
      message:
        "Fetching product metafield definitions from production store...",
    });

    const productionDefinitions = await getMetafieldDefinitions(
      "PRODUCT",
      productionStore,
      accessToken,
    );

    log.push({
      timestamp: new Date().toISOString(),
      message: `Found ${productionDefinitions.length} product metafield definitions in production`,
    });

    // Step 2: Fetch existing definitions from staging
    log.push({
      timestamp: new Date().toISOString(),
      message: "Fetching existing definitions from staging store...",
    });

    const stagingDefinitions = await getExistingStagingDefinitions(
      "PRODUCT",
      stagingAdmin,
    );

    log.push({
      timestamp: new Date().toISOString(),
      message: `Found ${stagingDefinitions.length} existing definitions in staging`,
    });

    // Step 3: Compare and find missing definitions (case-insensitive for keys)
    const missingDefinitions = productionDefinitions.filter((prodDef) => {
      return !stagingDefinitions.some(
        (stageDef) =>
          stageDef.namespace === prodDef.namespace &&
          stageDef.key.toLowerCase() === prodDef.key.toLowerCase(),
      );
    });

    log.push({
      timestamp: new Date().toISOString(),
      message: `Found ${missingDefinitions.length} missing definitions to create`,
    });

    // Check for definitions that exist but with different casing
    const caseOnlyDifferences = productionDefinitions.filter((prodDef) => {
      return stagingDefinitions.some(
        (stageDef) =>
          stageDef.namespace === prodDef.namespace &&
          stageDef.key.toLowerCase() === prodDef.key.toLowerCase() &&
          stageDef.key !== prodDef.key,
      );
    });

    if (caseOnlyDifferences.length > 0) {
      log.push({
        timestamp: new Date().toISOString(),
        message: `ℹ️ Note: ${caseOnlyDifferences.length} definitions already exist with different casing and were skipped: ${caseOnlyDifferences.map((d) => `${d.namespace}.${d.key}`).join(", ")}`,
      });
    }

    // Step 4: Create missing definitions (first pass - without metaobject validations)
    const createResults = [];
    const definitionsWithMetaobjectValidations = []; // Track which ones need updating

    for (const definition of missingDefinitions) {
      // Skip app-owned namespaces from other apps (e.g., app--123456--custom)
      if (
        definition.namespace.startsWith("app--") &&
        !definition.namespace.includes("$app")
      ) {
        log.push({
          timestamp: new Date().toISOString(),
          message: `⚠️ Skipped ${definition.namespace}.${definition.key} - app-owned namespace from another app`,
          success: false,
          skipped: true,
        });

        createResults.push({
          definition: `${definition.namespace}.${definition.key}`,
          success: false,
          skipped: true,
          errors: "Cannot create definitions in another app's namespace",
        });
        continue;
      }

      // Check if this metafield has metaobject validations
      let hasMetaobjectValidation = false;
      let requiresMetaobjectValidation = false;
      let definitionToCreate = { ...definition };

      // Check if this is a metaobject reference type that requires validation
      if (
        definition.type &&
        (definition.type.name === "metaobject_reference" ||
          definition.type.name === "list.metaobject_reference")
      ) {
        requiresMetaobjectValidation = true;
      }

      if (definition.validations && definition.validations.length > 0) {
        hasMetaobjectValidation = definition.validations.some(
          (validation) =>
            validation.value &&
            validation.value.includes("gid://shopify/MetaobjectDefinition"),
        );

        if (hasMetaobjectValidation) {
          // Check if we can create without validations
          if (requiresMetaobjectValidation) {
            log.push({
              timestamp: new Date().toISOString(),
              message: `⚠️ Skipped ${definition.namespace}.${definition.key} - metaobject reference fields require a metaobject validation`,
              success: false,
              skipped: true,
            });

            createResults.push({
              definition: `${definition.namespace}.${definition.key}`,
              success: false,
              skipped: true,
              errors:
                "Metaobject reference fields require a metaobject validation that cannot be created yet",
            });
            continue;
          }

          // Track for second pass
          definitionsWithMetaobjectValidations.push({
            definition: definition,
            originalValidations: definition.validations,
          });

          // Create without validations in first pass
          definitionToCreate = {
            ...definition,
            validations: definition.validations.filter(
              (validation) =>
                !validation.value ||
                !validation.value.includes(
                  "gid://shopify/MetaobjectDefinition",
                ),
            ),
          };

          // If all validations were removed and it's a metaobject reference type, skip
          if (
            definitionToCreate.validations.length === 0 &&
            requiresMetaobjectValidation
          ) {
            log.push({
              timestamp: new Date().toISOString(),
              message: `⚠️ Skipped ${definition.namespace}.${definition.key} - metaobject reference field requires at least one validation`,
              success: false,
              skipped: true,
            });

            createResults.push({
              definition: `${definition.namespace}.${definition.key}`,
              success: false,
              skipped: true,
              errors:
                "Metaobject reference field requires at least one validation",
            });
            continue;
          }

          log.push({
            timestamp: new Date().toISOString(),
            message: `Creating ${definition.namespace}.${definition.key} without metaobject validations (will add in second pass)`,
          });
        }
      }

      // Skip Shopify-reserved namespaces
      if (
        definition.namespace.startsWith("shopify--") ||
        definition.namespace === "shopify"
      ) {
        log.push({
          timestamp: new Date().toISOString(),
          message: `⚠️ Skipped ${definition.namespace}.${definition.key} - Shopify reserved namespace`,
          success: false,
          skipped: true,
        });

        createResults.push({
          definition: `${definition.namespace}.${definition.key}`,
          success: false,
          skipped: true,
          errors: "Cannot create definitions in Shopify reserved namespace",
        });
        continue;
      }

      log.push({
        timestamp: new Date().toISOString(),
        message: `Creating definition: ${definitionToCreate.namespace}.${definitionToCreate.key} (type: ${definition.type?.name || "unknown"})`,
      });

      const result = await createMetafieldDefinition(
        definitionToCreate,
        stagingAdmin,
      );

      if (result.success) {
        log.push({
          timestamp: new Date().toISOString(),
          message: `✅ Successfully created: ${definition.namespace}.${definition.key}`,
          success: true,
        });
      } else {
        log.push({
          timestamp: new Date().toISOString(),
          message: `❌ Failed to create ${definition.namespace}.${definition.key}: ${result.errors}`,
          success: false,
          error: result.errors,
        });
      }

      createResults.push({
        definition: `${definition.namespace}.${definition.key}`,
        ...result,
      });
    }

    // Step 5: Second pass - update metafields with metaobject validations
    if (definitionsWithMetaobjectValidations.length > 0) {
      log.push({
        timestamp: new Date().toISOString(),
        message: `Starting second pass to add metaobject validations to ${definitionsWithMetaobjectValidations.length} metafield(s)`,
      });

      // Import the function from metaobjects service
      const { getExistingStagingMetaobjectDefinitions } = await import(
        "./sync.metaobjects.server.js"
      );

      // Get all metaobject definitions from staging to build ID mapping
      const stagingMetaobjectDefs =
        await getExistingStagingMetaobjectDefinitions(stagingAdmin);
      const metaobjectIdMapping = {};

      for (const metaobjectDef of stagingMetaobjectDefs) {
        metaobjectIdMapping[metaobjectDef.type] = metaobjectDef.id;
      }

      // Also get production metaobject definitions to map types to IDs
      const productionMetaobjectQuery = `
        query GetMetaobjectDefinitions {
          metaobjectDefinitions(first: 50) {
            edges {
              node {
                id
                type
              }
            }
          }
        }
      `;

      try {
        const prodMetaobjectResponse = await fetch(
          `https://${productionStore}/admin/api/2025-01/graphql.json`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Shopify-Access-Token": accessToken,
            },
            body: JSON.stringify({ query: productionMetaobjectQuery }),
          },
        );

        const prodMetaobjectData = await prodMetaobjectResponse.json();
        const productionMetaobjectMapping = {};

        if (prodMetaobjectData.data?.metaobjectDefinitions?.edges) {
          for (const edge of prodMetaobjectData.data.metaobjectDefinitions
            .edges) {
            productionMetaobjectMapping[edge.node.id] = edge.node.type;
          }
        }

        // Update each metafield with corrected validations
        for (const defToUpdate of definitionsWithMetaobjectValidations) {
          const { definition, originalValidations } = defToUpdate;

          // Update validations to use staging IDs
          const updatedValidations = originalValidations.map((validation) => {
            if (
              validation.value &&
              validation.value.includes("gid://shopify/MetaobjectDefinition")
            ) {
              // Get the type from production ID
              const productionType =
                productionMetaobjectMapping[validation.value];

              if (productionType && metaobjectIdMapping[productionType]) {
                return {
                  ...validation,
                  value: metaobjectIdMapping[productionType],
                };
              }
            }
            return validation;
          });

          const updateDefinition = {
            ...definition,
            validations: updatedValidations,
          };

          log.push({
            timestamp: new Date().toISOString(),
            message: `Updating ${definition.namespace}.${definition.key} with metaobject validations`,
          });

          const updateResult = await updateMetafieldDefinition(
            updateDefinition,
            stagingAdmin,
          );

          if (updateResult.success) {
            log.push({
              timestamp: new Date().toISOString(),
              message: `✅ Successfully updated ${definition.namespace}.${definition.key} with metaobject validations`,
              success: true,
            });
            defToUpdate.updateSuccess = true;
          } else {
            log.push({
              timestamp: new Date().toISOString(),
              message: `❌ Failed to update ${definition.namespace}.${definition.key}: ${updateResult.errors}`,
              success: false,
              error: updateResult.errors,
            });
            defToUpdate.updateSuccess = false;
          }
        }
      } catch (error) {
        log.push({
          timestamp: new Date().toISOString(),
          message: `❌ Error in second pass: ${error.message}`,
          success: false,
          error: error.message,
        });
      }
    }

    // Summary
    const successCount = createResults.filter((r) => r.success).length;
    const skippedCount = createResults.filter((r) => r.skipped).length;
    const failureCount = createResults.filter(
      (r) => !r.success && !r.skipped,
    ).length;

    // Count skip reasons
    const shopifyNamespaceCount = createResults.filter(
      (r) => r.skipped && r.errors?.includes("Shopify reserved namespace"),
    ).length;
    const appNamespaceCount = createResults.filter(
      (r) => r.skipped && r.errors?.includes("another app's namespace"),
    ).length;
    const metaobjectRequiredCount = createResults.filter(
      (r) => r.skipped && r.errors?.includes("require a metaobject validation"),
    ).length;

    // Count second pass results
    const updatedCount = definitionsWithMetaobjectValidations.filter(
      (def) => def.updateSuccess === true,
    ).length;
    const updateFailedCount = definitionsWithMetaobjectValidations.filter(
      (def) => def.updateSuccess === false,
    ).length;

    let completionMessage = `Sync completed: ${successCount} created, ${skippedCount} skipped, ${failureCount} failed`;

    // Add skip reason details
    const skipReasons = [];
    if (shopifyNamespaceCount > 0) {
      skipReasons.push(`${shopifyNamespaceCount} Shopify namespace`);
    }
    if (appNamespaceCount > 0) {
      skipReasons.push(`${appNamespaceCount} app-owned`);
    }
    if (metaobjectRequiredCount > 0) {
      skipReasons.push(`${metaobjectRequiredCount} require metaobject`);
    }

    if (skipReasons.length > 0) {
      completionMessage += ` (Skipped: ${skipReasons.join(", ")})`;
    }

    if (definitionsWithMetaobjectValidations.length > 0) {
      completionMessage += `. Second pass: ${updatedCount} updated, ${updateFailedCount} failed`;
    }

    log.push({
      timestamp: new Date().toISOString(),
      message: completionMessage,
      summary: {
        total: productionDefinitions.length,
        existing: stagingDefinitions.length,
        created: successCount,
        skipped: skippedCount,
        failed: failureCount,
        updated: updatedCount,
        updateFailed: updateFailedCount,
      },
    });

    return {
      success: true,
      logs: log,
      results: createResults,
      summary: {
        total: productionDefinitions.length,
        existing: stagingDefinitions.length,
        created: successCount,
        skipped: skippedCount,
        failed: failureCount,
        updated: updatedCount,
        updateFailed: updateFailedCount,
      },
    };
  } catch (error) {
    log.push({
      timestamp: new Date().toISOString(),
      message: `Fatal error: ${error.message}`,
      error: error.stack,
    });

    return {
      success: false,
      logs: log,
      error: error.message,
    };
  }
}
