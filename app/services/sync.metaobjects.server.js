// Service for syncing metaobject definitions between stores

// Fetch metaobject definitions from a store
async function getMetaobjectDefinitions(store, token) {
  const query = `
    query getMetaobjectDefinitions($cursor: String) {
      metaobjectDefinitions(first: 50, after: $cursor) {
        edges {
          node {
            id
            type
            name
            displayNameKey
            description
            capabilities {
              publishable {
                enabled
              }
              translatable {
                enabled
              }
              renderable {
                enabled
              }
            }
            fieldDefinitions {
              key
              name
              description
              required
              type {
                name
                category
              }
              validations {
                name
                value
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
          body: JSON.stringify({ query, variables: { cursor } }),
        },
      );

      const data = await response.json();

      if (data.errors) {
        console.error("GraphQL errors:", data.errors);
        break;
      }

      const edges = data.data?.metaobjectDefinitions?.edges || [];
      definitions.push(...edges.map((edge) => edge.node));

      hasNextPage =
        data.data?.metaobjectDefinitions?.pageInfo?.hasNextPage || false;
      cursor = edges[edges.length - 1]?.cursor || null;
    } catch (error) {
      console.error("Error fetching metaobject definitions:", error);
      break;
    }
  }

  return definitions;
}

// Fetch existing metaobject definitions from staging
export async function getExistingStagingMetaobjectDefinitions(stagingAdmin) {
  const query = `
    query getMetaobjectDefinitions($cursor: String) {
      metaobjectDefinitions(first: 50, after: $cursor) {
        edges {
          node {
            id
            type
            name
          }
          cursor
        }
        pageInfo {
          hasNextPage
        }
      }
    }
  `;

  try {
    const response = await stagingAdmin.graphql(query);
    const data = await response.json();
    return data.data.metaobjectDefinitions.edges.map((edge) => edge.node);
  } catch (error) {
    console.error("Error fetching staging metaobject definitions:", error);
    return [];
  }
}

// Create a metaobject definition in staging
async function createMetaobjectDefinition(definition, stagingAdmin) {
  const mutation = `
    mutation CreateMetaobjectDefinition($definition: MetaobjectDefinitionCreateInput!) {
      metaobjectDefinitionCreate(definition: $definition) {
        metaobjectDefinition {
          id
          type
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

  // Prepare the input
  // Filter out fields that have metaobject references to avoid validation issues
  const filteredFields = definition.fieldDefinitions.filter((field) => {
    if (field.type.name === "metaobject_reference") {
      console.log(
        `Skipping field ${field.key} in ${definition.type} because it's a metaobject reference`,
      );
      return false;
    }
    return true;
  });

  // Log if we're skipping fields
  const skippedFieldCount =
    definition.fieldDefinitions.length - filteredFields.length;
  if (skippedFieldCount > 0) {
    console.log(
      `Creating ${definition.type} without ${skippedFieldCount} metaobject reference field(s)`,
    );
  }

  const definitionInput = {
    type: definition.type,
    name: definition.name,
    description: definition.description,
    fieldDefinitions: filteredFields.map((field) => ({
      key: field.key,
      name: field.name,
      description: field.description,
      required: field.required,
      type: field.type.name,
      validations: field.validations,
    })),
    capabilities: {
      publishable: definition.capabilities?.publishable,
      translatable: definition.capabilities?.translatable,
      renderable: definition.capabilities?.renderable,
    },
  };

  // Remove null/undefined values from capabilities
  if (definitionInput.capabilities.publishable === undefined) {
    delete definitionInput.capabilities.publishable;
  }
  if (definitionInput.capabilities.translatable === undefined) {
    delete definitionInput.capabilities.translatable;
  }
  if (definitionInput.capabilities.renderable === undefined) {
    delete definitionInput.capabilities.renderable;
  }

  // If displayNameKey exists, add it
  if (definition.displayNameKey) {
    definitionInput.displayNameKey = definition.displayNameKey;
  }

  try {
    console.log(
      "Creating metaobject definition with input:",
      JSON.stringify(definitionInput, null, 2),
    );

    const response = await stagingAdmin.graphql(mutation, {
      variables: { definition: definitionInput },
    });

    const data = await response.json();

    // Check for GraphQL errors
    if (data.errors) {
      console.error("GraphQL errors:", JSON.stringify(data.errors, null, 2));
      return {
        success: false,
        errors: data.errors.map((e) => e.message).join(", "),
      };
    }

    // Check for user errors
    if (
      data.data.metaobjectDefinitionCreate.userErrors &&
      data.data.metaobjectDefinitionCreate.userErrors.length > 0
    ) {
      return {
        success: false,
        errors: data.data.metaobjectDefinitionCreate.userErrors
          .map((e) => `${e.field}: ${e.message} (${e.code})`)
          .join(", "),
      };
    }

    return {
      success: true,
      definition: data.data.metaobjectDefinitionCreate.metaobjectDefinition,
    };
  } catch (error) {
    console.error("Error in createMetaobjectDefinition:", error);
    return {
      success: false,
      errors: error.message || "Failed to create metaobject definition",
    };
  }
}

// Update a metaobject definition to add reference fields
async function updateMetaobjectDefinition(type, fieldsToAdd, stagingAdmin) {
  const mutation = `
    mutation UpdateMetaobjectDefinition($id: ID!, $definition: MetaobjectDefinitionUpdateInput!) {
      metaobjectDefinitionUpdate(id: $id, definition: $definition) {
        metaobjectDefinition {
          id
          type
          fieldDefinitions {
            key
            name
            type {
              name
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

  try {
    // First, get the metaobject definition ID
    const getQuery = `
      query GetMetaobjectDefinition($type: String!) {
        metaobjectDefinitionByType(type: $type) {
          id
        }
      }
    `;

    const getResponse = await stagingAdmin.graphql(getQuery, {
      variables: { type },
    });
    const getData = await getResponse.json();

    if (!getData.data?.metaobjectDefinitionByType?.id) {
      return {
        success: false,
        errors: `Metaobject definition ${type} not found`,
      };
    }

    const definitionId = getData.data.metaobjectDefinitionByType.id;

    // Update with new fields - each field needs to be wrapped in a create operation
    const definitionInput = {
      fieldDefinitions: fieldsToAdd.map((field) => ({
        create: {
          key: field.key,
          type: field.type, // This should be a string like "metaobject_reference"
          name: field.name,
          description: field.description,
          required: field.required,
          validations: field.validations,
        },
      })),
    };

    console.log(
      "Update mutation input:",
      JSON.stringify(
        { id: definitionId, definition: definitionInput },
        null,
        2,
      ),
    );

    const response = await stagingAdmin.graphql(mutation, {
      variables: {
        id: definitionId,
        definition: definitionInput,
      },
    });

    const data = await response.json();

    if (data.errors) {
      return {
        success: false,
        errors: data.errors.map((e) => e.message).join(", "),
      };
    }

    if (
      data.data.metaobjectDefinitionUpdate.userErrors &&
      data.data.metaobjectDefinitionUpdate.userErrors.length > 0
    ) {
      return {
        success: false,
        errors: data.data.metaobjectDefinitionUpdate.userErrors
          .map((e) => `${e.field}: ${e.message} (${e.code})`)
          .join(", "),
      };
    }

    return {
      success: true,
      definition: data.data.metaobjectDefinitionUpdate.metaobjectDefinition,
    };
  } catch (error) {
    console.error("Error in updateMetaobjectDefinition:", error);
    return {
      success: false,
      errors: error.message || "Failed to update metaobject definition",
    };
  }
}

// Main sync function
export async function syncMetaobjectDefinitions(
  productionStore,
  accessToken,
  stagingAdmin,
) {
  const log = [];
  console.log("CREDENTIALS", productionStore, accessToken);

  try {
    // Step 1: Fetch metaobject definitions from production
    log.push({
      timestamp: new Date().toISOString(),
      message: "Fetching metaobject definitions from production store...",
    });

    const productionDefinitions = await getMetaobjectDefinitions(
      productionStore,
      accessToken,
    );

    log.push({
      timestamp: new Date().toISOString(),
      message: `Found ${productionDefinitions.length} metaobject definitions in production`,
    });

    // Step 2: Fetch existing definitions from staging
    log.push({
      timestamp: new Date().toISOString(),
      message: "Fetching existing metaobject definitions from staging store...",
    });

    const stagingDefinitions =
      await getExistingStagingMetaobjectDefinitions(stagingAdmin);

    log.push({
      timestamp: new Date().toISOString(),
      message: `Found ${stagingDefinitions.length} existing metaobject definitions in staging`,
    });

    // Step 3: Filter out reserved metaobjects (shopify-- prefix)
    const filteredProductionDefinitions = productionDefinitions.filter(
      (def) => !def.type.startsWith("shopify--"),
    );

    const reservedCount =
      productionDefinitions.length - filteredProductionDefinitions.length;
    if (reservedCount > 0) {
      log.push({
        timestamp: new Date().toISOString(),
        message: `Excluding ${reservedCount} reserved metaobjects (shopify-- prefix)`,
      });
    }

    // Step 4: Compare and find missing definitions (case-insensitive for types)
    const missingDefinitions = filteredProductionDefinitions.filter(
      (prodDef) => {
        return !stagingDefinitions.some(
          (stageDef) =>
            stageDef.type.toLowerCase() === prodDef.type.toLowerCase(),
        );
      },
    );

    log.push({
      timestamp: new Date().toISOString(),
      message: `Found ${missingDefinitions.length} missing metaobject definitions to create`,
    });

    // Check for definitions that exist but with different casing
    const caseOnlyDifferences = filteredProductionDefinitions.filter(
      (prodDef) => {
        return stagingDefinitions.some(
          (stageDef) =>
            stageDef.type.toLowerCase() === prodDef.type.toLowerCase() &&
            stageDef.type !== prodDef.type,
        );
      },
    );

    if (caseOnlyDifferences.length > 0) {
      log.push({
        timestamp: new Date().toISOString(),
        message: `ℹ️ Note: ${caseOnlyDifferences.length} metaobject definitions already exist with different casing and were skipped: ${caseOnlyDifferences.map((d) => d.type).join(", ")}`,
      });
    }

    // Step 4: Create missing definitions (first pass - without references)
    const createResults = [];
    const definitionsWithSkippedFields = []; // Track which ones need updating
    const idMapping = {}; // Map production types to staging IDs

    // Build initial ID mapping from existing definitions
    for (const stagingDef of stagingDefinitions) {
      idMapping[stagingDef.type] = stagingDef.id;
    }

    for (const definition of missingDefinitions) {
      // Check if this definition has metaobject reference fields
      const referenceFields = definition.fieldDefinitions.filter(
        (field) => field.type.name === "metaobject_reference",
      );

      if (referenceFields.length > 0) {
        definitionsWithSkippedFields.push({
          type: definition.type,
          referenceFields: referenceFields,
          originalDefinition: definition,
        });
      }

      log.push({
        timestamp: new Date().toISOString(),
        message: `Creating metaobject definition: ${definition.type}`,
      });

      const result = await createMetaobjectDefinition(definition, stagingAdmin);

      if (result.success) {
        // Add to ID mapping
        idMapping[definition.type] = result.definition.id;

        const skippedFieldCount = referenceFields.length;
        const message =
          skippedFieldCount > 0
            ? `✅ Successfully created: ${definition.type} (without ${skippedFieldCount} metaobject reference field(s))`
            : `✅ Successfully created: ${definition.type}`;

        log.push({
          timestamp: new Date().toISOString(),
          message,
          success: true,
        });
      } else {
        log.push({
          timestamp: new Date().toISOString(),
          message: `❌ Failed to create ${definition.type}: ${result.errors}`,
          success: false,
          error: result.errors,
        });
      }

      createResults.push({
        definition: definition.type,
        ...result,
      });
    }

    // Step 5: Second pass - update metaobjects with reference fields
    if (definitionsWithSkippedFields.length > 0) {
      log.push({
        timestamp: new Date().toISOString(),
        message: `Starting second pass to add reference fields to ${definitionsWithSkippedFields.length} metaobject(s)`,
      });

      // Refresh the staging definitions to get all IDs
      log.push({
        timestamp: new Date().toISOString(),
        message: "Refreshing staging metaobject definitions for ID mapping...",
      });

      const allStagingDefinitions =
        await getExistingStagingMetaobjectDefinitions(stagingAdmin);

      // Rebuild complete ID mapping
      const completeIdMapping = {};
      for (const stagingDef of allStagingDefinitions) {
        completeIdMapping[stagingDef.type] = stagingDef.id;
      }

      for (const defToUpdate of definitionsWithSkippedFields) {
        // Only process if the metaobject was successfully created
        if (!completeIdMapping[defToUpdate.type]) {
          continue;
        }

        const fieldsToAdd = defToUpdate.referenceFields.map((field) => {
          // Update validations to use staging IDs
          let updatedValidations = field.validations;

          if (field.validations && field.validations.length > 0) {
            updatedValidations = field.validations.map((validation) => {
              if (
                validation.name === "metaobject_definition_id" &&
                validation.value
              ) {
                // Extract the type from the production GID
                // Format: gid://shopify/MetaobjectDefinition/12345
                const match = validation.value.match(
                  /MetaobjectDefinition\/\d+$/,
                );
                if (match) {
                  // Find the referenced type in the original definitions
                  const referencedType = productionDefinitions.find(
                    (def) => def.id === validation.value,
                  )?.type;

                  if (referencedType && completeIdMapping[referencedType]) {
                    return {
                      ...validation,
                      value: completeIdMapping[referencedType], // Use staging ID
                    };
                  }
                }
              }
              return validation;
            });
          }

          return {
            key: field.key,
            name: field.name,
            description: field.description,
            required: field.required,
            type: field.type.name,
            validations: updatedValidations,
          };
        });

        console.log(
          `Fields to add for ${defToUpdate.type}:`,
          JSON.stringify(fieldsToAdd, null, 2),
        );

        log.push({
          timestamp: new Date().toISOString(),
          message: `Updating ${defToUpdate.type} with ${fieldsToAdd.length} reference field(s)`,
        });

        const updateResult = await updateMetaobjectDefinition(
          defToUpdate.type,
          fieldsToAdd,
          stagingAdmin,
        );

        if (updateResult.success) {
          log.push({
            timestamp: new Date().toISOString(),
            message: `✅ Successfully updated ${defToUpdate.type} with reference fields`,
            success: true,
          });
          defToUpdate.updateSuccess = true;
        } else {
          log.push({
            timestamp: new Date().toISOString(),
            message: `❌ Failed to update ${defToUpdate.type}: ${updateResult.errors}`,
            success: false,
            error: updateResult.errors,
          });
          defToUpdate.updateSuccess = false;
        }
      }
    }

    // Summary
    const successCount = createResults.filter((r) => r.success).length;
    const skippedCount = createResults.filter((r) => r.skipped).length;
    const failureCount = createResults.filter(
      (r) => !r.success && !r.skipped,
    ).length;

    // Count second pass results
    const updatedCount = definitionsWithSkippedFields.filter(
      (def) => def.updateSuccess === true,
    ).length;
    const updateFailedCount = definitionsWithSkippedFields.filter(
      (def) => def.updateSuccess === false,
    ).length;

    let completionMessage = `Sync completed: ${successCount} created, ${skippedCount} skipped, ${failureCount} failed, ${reservedCount} reserved`;
    if (definitionsWithSkippedFields.length > 0) {
      completionMessage += `. Second pass: ${updatedCount} updated, ${updateFailedCount} failed`;
    }

    log.push({
      timestamp: new Date().toISOString(),
      message: completionMessage,
      summary: {
        total: filteredProductionDefinitions.length,
        existing: stagingDefinitions.length,
        created: successCount,
        skipped: skippedCount,
        failed: failureCount,
        reserved: reservedCount,
        updated: updatedCount,
        updateFailed: updateFailedCount,
      },
    });

    return {
      success: failureCount === 0 && updateFailedCount === 0,
      logs: log,
      summary: {
        total: filteredProductionDefinitions.length,
        existing: stagingDefinitions.length,
        created: successCount,
        skipped: skippedCount,
        failed: failureCount,
        reserved: reservedCount,
        updated: updatedCount,
        updateFailed: updateFailedCount,
      },
    };
  } catch (error) {
    console.error("Error in syncMetaobjectDefinitions:", error);
    log.push({
      timestamp: new Date().toISOString(),
      message: `Fatal error: ${error.message}`,
      success: false,
      error: error.message,
    });

    return {
      success: false,
      logs: log,
      summary: {
        error: error.message,
      },
    };
  }
}
