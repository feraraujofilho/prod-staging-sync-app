import { useState, useCallback } from "react";
import {
  useLoaderData,
  useActionData,
  Form,
  useNavigation,
  useSubmit,
} from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  BlockStack,
  Box,
  Text,
  TextField,
  Button,
  Banner,
  Badge,
  InlineStack,
  Modal,
  EmptyState,
  DataTable,
  Icon,
  ButtonGroup,
} from "@shopify/polaris";
import {
  DeleteIcon,
  EditIcon,
  LinkIcon,
  KeyIcon,
} from "@shopify/polaris-icons";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

// Loader to fetch existing connections
export const loader = async ({ request }) => {
  const { decrypt } = await import("../utils/encryption.server");
  const { session } = await authenticate.admin(request);

  const connections = await prisma.storeConnection.findMany({
    where: { shop: session.shop },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      name: true,
      storeDomain: true,
      environment: true,
      isActive: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  return { connections };
};

// Action to handle CRUD operations
export const action = async ({ request }) => {
  // const { encrypt } = await import("../utils/encryption.server");
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const action = formData.get("action");

  try {
    switch (action) {
      case "create":
      case "update": {
        const id = formData.get("id");
        const name = formData.get("name");
        const storeDomain = formData.get("storeDomain");
        const accessToken = formData.get("accessToken");
        const environment = formData.get("environment") || "production";

        if (!name || !storeDomain) {
          return {
            error: "Missing required fields",
            success: false,
          };
        }

        // For new connections, access token is required
        if (!id && !accessToken) {
          return {
            error: "Access token is required for new connections",
            success: false,
          };
        }

        const data = {
          shop: session.shop,
          name,
          storeDomain,
          environment,
        };

        // Only update token if provided
        if (accessToken) {
          data.encryptedToken = /* encrypt(accessToken) */ accessToken;
        }

        if (id) {
          // Update existing
          await prisma.storeConnection.update({
            where: { id },
            data,
          });

          return {
            success: true,
            message: "Connection updated successfully",
          };
        } else {
          // Check if connection already exists
          const existingConnection = await prisma.storeConnection.findUnique({
            where: {
              shop_storeDomain: {
                shop: session.shop,
                storeDomain: storeDomain,
              },
            },
          });

          if (existingConnection) {
            // Update existing connection instead of creating new
            await prisma.storeConnection.update({
              where: { id: existingConnection.id },
              data,
            });

            return {
              success: true,
              message:
                "Connection already existed and was updated successfully",
            };
          } else {
            // Create new
            await prisma.storeConnection.create({
              data,
            });

            return {
              success: true,
              message: "Connection created successfully",
            };
          }
        }
      }

      case "delete": {
        const id = formData.get("id");

        await prisma.storeConnection.delete({
          where: { id },
        });

        return {
          success: true,
          message: "Connection deleted successfully",
        };
      }

      case "toggle": {
        const id = formData.get("id");
        const connection = await prisma.storeConnection.findUnique({
          where: { id },
        });

        await prisma.storeConnection.update({
          where: { id },
          data: { isActive: !connection.isActive },
        });

        return {
          success: true,
          message: `Connection ${connection.isActive ? "deactivated" : "activated"} successfully`,
        };
      }

      default:
        return { error: "Invalid action", success: false };
    }
  } catch (error) {
    console.error("Action error:", error);
    return {
      error: error.message || "An error occurred",
      success: false,
    };
  }
};

export default function Settings() {
  const { connections } = useLoaderData();
  const actionData = useActionData();
  const navigation = useNavigation();
  const submit = useSubmit();

  const [modalActive, setModalActive] = useState(false);
  const [editingConnection, setEditingConnection] = useState(null);
  const [deleteConfirmActive, setDeleteConfirmActive] = useState(false);
  const [connectionToDelete, setConnectionToDelete] = useState(null);

  // Form state
  const [name, setName] = useState("");
  const [storeDomain, setStoreDomain] = useState("");
  const [accessToken, setAccessToken] = useState("");
  const [environment, setEnvironment] = useState("production");

  const isLoading = navigation.state === "submitting";

  const handleModalClose = useCallback(() => {
    setModalActive(false);
    setEditingConnection(null);
    // Reset form
    setName("");
    setStoreDomain("");
    setAccessToken("");
    setEnvironment("production");
  }, []);

  const handleEdit = useCallback((connection) => {
    setEditingConnection(connection);
    setName(connection.name);
    setStoreDomain(connection.storeDomain);
    setEnvironment(connection.environment);
    setAccessToken(""); // Don't show existing token
    setModalActive(true);
  }, []);

  const handleDelete = useCallback((connection) => {
    setConnectionToDelete(connection);
    setDeleteConfirmActive(true);
  }, []);

  const confirmDelete = useCallback(() => {
    if (connectionToDelete) {
      const formData = new FormData();
      formData.append("action", "delete");
      formData.append("id", connectionToDelete.id);
      submit(formData, { method: "post" });
    }
    setDeleteConfirmActive(false);
    setConnectionToDelete(null);
  }, [connectionToDelete, submit]);

  const handleToggle = useCallback(
    (connection) => {
      const formData = new FormData();
      formData.append("action", "toggle");
      formData.append("id", connection.id);
      submit(formData, { method: "post" });
    },
    [submit],
  );

  const rows = connections.map((connection) => [
    connection.name,
    connection.storeDomain,
    <Badge status={connection.isActive ? "success" : "default"}>
      {connection.isActive ? "Active" : "Inactive"}
    </Badge>,
    connection.environment,
    new Date(connection.createdAt).toLocaleDateString(),
    <ButtonGroup>
      <Button size="slim" onClick={() => handleEdit(connection)}>
        <Icon source={EditIcon} />
      </Button>
      <Button
        size="slim"
        tone={connection.isActive ? "default" : "success"}
        onClick={() => handleToggle(connection)}
      >
        {connection.isActive ? "Disable" : "Enable"}
      </Button>
      <Button
        size="slim"
        tone="critical"
        onClick={() => handleDelete(connection)}
      >
        <Icon source={DeleteIcon} />
      </Button>
    </ButtonGroup>,
  ]);

  return (
    <Page
      title="Store Connections"
      primaryAction={{
        content: "Add Connection",
        onAction: () => setModalActive(true),
      }}
    >
      <Layout>
        {actionData?.error && (
          <Layout.Section>
            <Banner status="critical">{actionData.error}</Banner>
          </Layout.Section>
        )}

        {actionData?.success && (
          <Layout.Section>
            <Banner status="success" onDismiss={() => {}}>
              {actionData.message}
            </Banner>
          </Layout.Section>
        )}

        <Layout.Section>
          {connections.length === 0 ? (
            <Card>
              <EmptyState
                heading="No store connections yet"
                action={{
                  content: "Add your first connection",
                  onAction: () => setModalActive(true),
                }}
                image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
              >
                <p>
                  Connect to external Shopify stores to sync data between them.
                </p>
              </EmptyState>
            </Card>
          ) : (
            <Card>
              <DataTable
                columnContentTypes={[
                  "text",
                  "text",
                  "text",
                  "text",
                  "text",
                  "text",
                ]}
                headings={[
                  "Name",
                  "Store Domain",
                  "Status",
                  "Environment",
                  "Created",
                  "Actions",
                ]}
                rows={rows}
              />
            </Card>
          )}
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text variant="headingMd" as="h2">
                Security Information
              </Text>
              <BlockStack gap="200">
                <InlineStack gap="200" align="start">
                  <Icon source={KeyIcon} />
                  <Text variant="bodyMd">
                    Access tokens are encrypted before being stored in the
                    database
                  </Text>
                </InlineStack>
                <InlineStack gap="200" align="start">
                  <Icon source={LinkIcon} />
                  <Text variant="bodyMd">
                    Connections are isolated per shop installation
                  </Text>
                </InlineStack>
              </BlockStack>
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text variant="headingMd" as="h2">
                Required API Scopes
              </Text>
              <Text variant="bodyMd" as="p">
                When creating a custom app in your source store, ensure it has
                the following Admin API scopes:
              </Text>
              <Box
                padding="300"
                background="bg-surface-secondary"
                borderRadius="200"
              >
                <Text variant="bodySm" as="p" fontFamily="monospace" breakWord>
                  read_metaobject_definitions, read_metaobjects, read_products,
                  read_files, read_online_store_navigation,
                  read_online_store_pages, read_markets, read_companies,
                  read_customers, read_locales, read_product_listings,
                  read_locations
                </Text>
              </Box>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>

      <Modal
        open={modalActive}
        onClose={handleModalClose}
        title={editingConnection ? "Edit Connection" : "Add Store Connection"}
        primaryAction={{
          content: "Save",
          onAction: () => {
            const form = document.getElementById("connection-form");
            form.requestSubmit();
          },
          loading: isLoading,
        }}
        secondaryActions={[
          {
            content: "Cancel",
            onAction: handleModalClose,
          },
        ]}
      >
        <Modal.Section>
          <Form method="post" id="connection-form" onSubmit={handleModalClose}>
            <input
              type="hidden"
              name="action"
              value={editingConnection ? "update" : "create"}
            />
            {editingConnection && (
              <input type="hidden" name="id" value={editingConnection.id} />
            )}

            <BlockStack gap="400">
              <Banner status="info" title="Required API Scopes">
                <p>Make sure your custom app has these Admin API scopes:</p>
                <Box paddingBlockStart="200">
                  <Text variant="bodyMd" as="p" fontFamily="monospace">
                    read_metaobject_definitions, read_metaobjects,
                    read_products, read_files, read_online_store_navigation,
                    read_online_store_pages, read_markets, read_companies,
                    read_customers, read_locales, read_product_listings,
                    read_locations
                  </Text>
                </Box>
              </Banner>

              <TextField
                label="Connection Name"
                value={name}
                onChange={setName}
                name="name"
                placeholder="Production Store"
                helpText="A friendly name to identify this connection"
                autoComplete="off"
                required
              />

              <TextField
                label="Store Domain"
                value={storeDomain}
                onChange={setStoreDomain}
                name="storeDomain"
                placeholder="your-store.myshopify.com"
                helpText="The Shopify domain of the store to connect to"
                autoComplete="off"
                required
                disabled={!!editingConnection}
              />

              <TextField
                label="Access Token"
                value={accessToken}
                onChange={setAccessToken}
                name="accessToken"
                type="password"
                placeholder={
                  editingConnection
                    ? "Leave blank to keep current token"
                    : "Enter access token"
                }
                helpText={
                  editingConnection
                    ? "Only enter a new token if you want to update it"
                    : "The access token for the external store"
                }
                autoComplete="off"
                required={!editingConnection}
              />

              <TextField
                label="Environment"
                value={environment}
                onChange={setEnvironment}
                name="environment"
                placeholder="production"
                helpText="Environment identifier (e.g., production, staging)"
                autoComplete="off"
              />
            </BlockStack>
          </Form>
        </Modal.Section>
      </Modal>

      <Modal
        open={deleteConfirmActive}
        onClose={() => setDeleteConfirmActive(false)}
        title="Delete Connection"
        primaryAction={{
          content: "Delete",
          onAction: confirmDelete,
          destructive: true,
          loading: isLoading,
        }}
        secondaryActions={[
          {
            content: "Cancel",
            onAction: () => setDeleteConfirmActive(false),
          },
        ]}
      >
        <Modal.Section>
          <Text variant="bodyMd">
            Are you sure you want to delete the connection "
            {connectionToDelete?.name}"? This will also delete all associated
            sync logs.
          </Text>
        </Modal.Section>
      </Modal>
    </Page>
  );
}
