// app-staging/app/routes/app.sync-metafields.jsx
import { useState } from "react";
import { Form, useActionData, useNavigation } from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  FormLayout,
  TextField,
  Button,
  Banner,
  Text,
  BlockStack,
  InlineStack,
  Badge,
  Scrollable,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }) => {
  await authenticate.admin(request);
  return null;
};

export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();

  const productionStore = formData.get("productionStore");
  const accessToken = formData.get("accessToken");

  // We'll implement the sync logic here
  const syncResults = await syncMetafields(productionStore, accessToken, admin);

  return syncResults;
};

export default function SyncMetafields() {
  const actionData = useActionData();
  const navigation = useNavigation();
  const isLoading = navigation.state === "submitting";

  const [productionStore, setProductionStore] = useState("");
  const [accessToken, setAccessToken] = useState("");

  return (
    <Page title="Sync Product Metafields">
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="500">
              <Text as="p" variant="bodyMd">
                Sync product metafields from your production store to this
                staging store.
              </Text>

              <Form method="post">
                <FormLayout>
                  <TextField
                    label="Production Store Domain"
                    value={productionStore}
                    onChange={setProductionStore}
                    name="productionStore"
                    placeholder="your-store.myshopify.com"
                    helpText="Enter the domain of your production store"
                    autoComplete="off"
                    required
                  />

                  <TextField
                    label="Production Store Access Token"
                    value={accessToken}
                    onChange={setAccessToken}
                    name="accessToken"
                    type="password"
                    helpText="Enter the access token for the production store"
                    autoComplete="off"
                    required
                  />

                  <Button submit primary loading={isLoading}>
                    {isLoading ? "Syncing..." : "Start Sync"}
                  </Button>
                </FormLayout>
              </Form>
            </BlockStack>
          </Card>
        </Layout.Section>

        {actionData && (
          <Layout.Section>
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Sync Results
                </Text>

                {actionData.error && (
                  <Banner status="critical">
                    <p>{actionData.error}</p>
                  </Banner>
                )}

                {actionData.summary && (
                  <BlockStack gap="200">
                    <InlineStack gap="400">
                      <Badge status="info">
                        Products Processed:{" "}
                        {actionData.summary.productsProcessed}
                      </Badge>
                      <Badge status="success">
                        Metafields Created:{" "}
                        {actionData.summary.metafieldsCreated}
                      </Badge>
                      <Badge status="warning">
                        Metafields Updated:{" "}
                        {actionData.summary.metafieldsUpdated}
                      </Badge>
                      <Badge status="critical">
                        Errors: {actionData.summary.errors}
                      </Badge>
                    </InlineStack>
                  </BlockStack>
                )}

                {actionData.logs && actionData.logs.length > 0 && (
                  <Card sectioned>
                    <BlockStack gap="200">
                      <Text as="h3" variant="headingSm">
                        Sync Log
                      </Text>
                      <Scrollable style={{ height: "400px" }}>
                        <BlockStack gap="100">
                          {actionData.logs.map((log, index) => (
                            <Text
                              key={index}
                              as="p"
                              variant="bodySm"
                              tone={
                                log.type === "error" ? "critical" : "subdued"
                              }
                            >
                              [{log.timestamp}] {log.message}
                            </Text>
                          ))}
                        </BlockStack>
                      </Scrollable>
                    </BlockStack>
                  </Card>
                )}
              </BlockStack>
            </Card>
          </Layout.Section>
        )}
      </Layout>
    </Page>
  );
}

// Add this function in the same file (app.sync-metafields.jsx)

async function syncMetafields(productionStore, accessToken, stagingAdmin) {
  const logs = [];
  const summary = {
    productsProcessed: 0,
    metafieldsCreated: 0,
    metafieldsUpdated: 0,
    errors: 0,
  };

  const log = (message, type = "info") => {
    logs.push({
      timestamp: new Date().toISOString().split("T")[1].split(".")[0],
      message,
      type,
    });
  };

  try {
    log("Starting metafield sync...");

    // Fetch metafield definitions
    const metafieldDefinitions = await getMetafieldDefinitions(
      "PRODUCT",
      "aafb79-1d.myshopify.com",
      accessToken,
    );
    log(`Found ${metafieldDefinitions.length} metafield definitions`);

    // Fetch all products from staging store first
    const stagingProducts = await fetchAllProducts(stagingAdmin, log);
    log(`Found ${stagingProducts.length} products in staging store`);

    // Create a map of staging products by handle for easy lookup
    const stagingProductMap = new Map();
    stagingProducts.forEach((product) => {
      stagingProductMap.set(product.handle, product);
    });

    // Fetch products from production store
    log("Fetching products from production store...");
    const productionProducts = await fetchProductsFromExternalStore(
      productionStore,
      accessToken,
      log,
    );
    log(`Found ${productionProducts.length} products in production store`);

    // Sync metafields for each product
    for (const prodProduct of productionProducts) {
      const stagingProduct = stagingProductMap.get(prodProduct.handle);

      if (!stagingProduct) {
        log(
          `Skipping product "${prodProduct.title}" - not found in staging`,
          "warning",
        );
        continue;
      }

      summary.productsProcessed++;

      // Sync metafields for this product
      const metafieldResults = await syncProductMetafields(
        prodProduct,
        stagingProduct,
        stagingAdmin,
        log,
      );

      summary.metafieldsCreated += metafieldResults.created;
      summary.metafieldsUpdated += metafieldResults.updated;
      summary.errors += metafieldResults.errors;
    }

    log(`Sync completed! Processed ${summary.productsProcessed} products`);
  } catch (error) {
    log(`Fatal error: ${error.message}`, "error");
    return { error: error.message, logs };
  }

  return { summary, logs };
}

// Add these helper functions to the same file

async function fetchAllProducts(admin, log) {
  const products = [];
  let hasNextPage = true;
  let cursor = null;

  while (hasNextPage) {
    const query = `
      query GetProducts($cursor: String) {
        products(first: 250, after: $cursor) {
          edges {
            node {
              id
              handle
              title
            }
            cursor
          }
          pageInfo {
            hasNextPage
          }
        }
      }
    `;

    const response = await admin.graphql(query, { variables: { cursor } });
    const data = await response.json();

    data.data.products.edges.forEach((edge) => {
      products.push(edge.node);
      cursor = edge.cursor;
    });

    hasNextPage = data.data.products.pageInfo.hasNextPage;
  }

  return products;
}

async function fetchProductsFromExternalStore(store, token, log) {
  const products = [];
  let hasNextPage = true;
  let cursor = null;

  while (hasNextPage) {
    const query = `
      query GetProductsWithMetafields($cursor: String) {
        products(first: 50, after: $cursor) {
          edges {
            node {
              id
              handle
              title
              metafields(first: 250) {
                edges {
                  node {
                    id
                    namespace
                    key
                    value
                    type
                  }
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

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data = await response.json();

      if (data.errors) {
        throw new Error(data.errors[0].message);
      }

      data.data.products.edges.forEach((edge) => {
        products.push({
          ...edge.node,
          metafields: edge.node.metafields.edges.map((e) => e.node),
        });
        cursor = edge.cursor;
      });

      hasNextPage = data.data.products.pageInfo.hasNextPage;
    } catch (error) {
      log(`Error fetching from production: ${error.message}`, "error");
      throw error;
    }
  }

  return products;
}

async function syncProductMetafields(prodProduct, stagingProduct, admin, log) {
  const results = { created: 0, updated: 0, errors: 0 };

  log(`Syncing metafields for product: ${prodProduct.title}`);

  // Get existing metafields from staging
  const existingMetafields = await fetchProductMetafields(
    stagingProduct.id,
    admin,
  );
  const existingMap = new Map();

  existingMetafields.forEach((mf) => {
    existingMap.set(`${mf.namespace}.${mf.key}`, mf);
  });

  // Sync each metafield
  for (const metafield of prodProduct.metafields) {
    try {
      const existingMf = existingMap.get(
        `${metafield.namespace}.${metafield.key}`,
      );

      const mutation = `
        mutation SetMetafield($metafields: [MetafieldsSetInput!]!) {
          metafieldsSet(metafields: $metafields) {
            metafields {
              id
              namespace
              key
            }
            userErrors {
              field
              message
            }
          }
        }
      `;

      const variables = {
        metafields: [
          {
            ownerId: stagingProduct.id,
            namespace: metafield.namespace,
            key: metafield.key,
            value: metafield.value,
            type: metafield.type,
          },
        ],
      };

      const response = await admin.graphql(mutation, { variables });
      const data = await response.json();

      if (data.data.metafieldsSet.userErrors.length > 0) {
        throw new Error(data.data.metafieldsSet.userErrors[0].message);
      }

      if (existingMf) {
        results.updated++;
        log(`  Updated: ${metafield.namespace}.${metafield.key}`);
      } else {
        results.created++;
        log(`  Created: ${metafield.namespace}.${metafield.key}`);
      }
    } catch (error) {
      results.errors++;
      log(
        `  Error syncing ${metafield.namespace}.${metafield.key}: ${error.message}`,
        "error",
      );
    }
  }

  return results;
}

async function fetchProductMetafields(productId, admin) {
  const query = `
    query GetProductMetafields($productId: ID!) {
      product(id: $productId) {
        metafields(first: 250) {
          edges {
            node {
              id
              namespace
              key
              value
              type
            }
          }
        }
      }
    }
  `;

  const response = await admin.graphql(query, { variables: { productId } });
  const data = await response.json();

  return data.data.product.metafields.edges.map((e) => e.node);
}

async function getMetafieldDefinitions(
  ownerType,
  productionStore,
  accessToken,
) {
  const query = `
    query GetMetafieldDefinitions($ownerType: MetafieldOwnerType!) {
      metafieldDefinitions(ownerType: $ownerType, first: 100) {
        edges {
          node {
            id
            namespace
            key
            type {
              name
            }
            description
            ownerType
          }
        }
      }
    }
  `;

  console.log("productionStore", productionStore);
  console.log("accessToken", accessToken);

  try {
    // Make HTTP request to external store
    const response = await fetch(
      `https://${productionStore}/admin/api/2025-01/graphql.json`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": accessToken, // Production store token
        },
        body: JSON.stringify({
          query,
          variables: { ownerType },
        }),
      },
    );

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = await response.json();

    if (data.errors) {
      throw new Error(`GraphQL error: ${data.errors[0].message}`);
    }

    return data.data.metafieldDefinitions.edges.map((e) => e.node);
  } catch (error) {
    console.error("Error fetching metafield definitions:", error);
    throw error;
  }
}

// Check which metafield definitions already exist in staging
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
            description
            ownerType
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

    if (data.errors) {
      console.error("Staging GraphQL errors:", data.errors);
      throw new Error("Failed to fetch staging metafield definitions");
    }

    return data.data.metafieldDefinitions.edges.map((edge) => edge.node);
  } catch (error) {
    console.error("Error fetching staging metafield definitions:", error);
    throw error;
  }
}
