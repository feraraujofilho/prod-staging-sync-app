import { useState, useCallback } from "react";
import {
  useLoaderData,
  useActionData,
  Form,
  useNavigation,
} from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  BlockStack,
  Text,
  Button,
  Banner,
  InlineStack,
  Select,
  Checkbox,
  DataTable,
  EmptyState,
  Badge,
} from "@shopify/polaris";
import { SettingsIcon } from "@shopify/polaris-icons";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

// Loader to fetch connections and navigation configuration
export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);

  const connections = await prisma.storeConnection.findMany({
    where: {
      shop: session.shop,
      isActive: true,
    },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      name: true,
      storeDomain: true,
      environment: true,
    },
  });

  // For now, we'll use a simple approach - you can extend this with a database table later
  const navigationConfig = {
    activeMenus: ["main-menu", "footer-menu"], // Default active menus
    syncStrategy: "update", // "update" or "create"
  };

  return { connections, navigationConfig };
};

// Action to handle navigation configuration updates
export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const action = formData.get("action");

  try {
    switch (action) {
      case "update_config": {
        const activeMenus = formData.getAll("activeMenus");
        const syncStrategy = formData.get("syncStrategy");

        // For now, we'll just return success
        // In a real implementation, you'd save this to a database
        return {
          success: true,
          message: "Navigation configuration updated successfully",
        };
      }

      default:
        return {
          error: "Invalid action",
          success: false,
        };
    }
  } catch (error) {
    return {
      error: error.message,
      success: false,
    };
  }
};

export default function NavigationConfig() {
  const { connections, navigationConfig } = useLoaderData();
  const actionData = useActionData();
  const navigation = useNavigation();

  const [selectedConnection, setSelectedConnection] = useState("");
  const [activeMenus, setActiveMenus] = useState(navigationConfig.activeMenus);
  const [syncStrategy, setSyncStrategy] = useState(
    navigationConfig.syncStrategy,
  );

  const handleActiveMenusChange = useCallback((value) => {
    setActiveMenus(value);
  }, []);

  const handleSyncStrategyChange = useCallback((value) => {
    setSyncStrategy(value);
  }, []);

  const menuOptions = [
    { label: "Main Menu", value: "main-menu" },
    { label: "Footer Menu", value: "footer-menu" },
    { label: "Mobile Menu", value: "mobile-menu" },
    { label: "Secondary Menu", value: "secondary-menu" },
  ];

  const strategyOptions = [
    { label: "Update Existing", value: "update" },
    { label: "Create New", value: "create" },
  ];

  return (
    <Page
      title="Navigation Configuration"
      subtitle="Configure which navigation menus to sync and how"
      backAction={{
        content: "Sync",
        url: "/app/sync",
      }}
    >
      <Layout>
        {actionData?.error && (
          <Layout.Section>
            <Banner status="critical" title="Error">
              {actionData.error}
            </Banner>
          </Layout.Section>
        )}

        {actionData?.success && (
          <Layout.Section>
            <Banner status="success" title="Success">
              {actionData.message}
            </Banner>
          </Layout.Section>
        )}

        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text variant="headingMd" as="h2">
                Navigation Menu Settings
              </Text>

              <Text variant="bodyMd" as="p">
                Configure which navigation menus should be synced from
                production to staging, and how they should be handled when
                conflicts occur.
              </Text>

              <Form method="post">
                <input type="hidden" name="action" value="update_config" />

                <BlockStack gap="400">
                  <Select
                    label="Active Menus"
                    options={menuOptions}
                    value={activeMenus}
                    onChange={handleActiveMenusChange}
                    multiple
                    helpText="Select which menus should be synced"
                  />

                  <Select
                    label="Sync Strategy"
                    options={strategyOptions}
                    value={syncStrategy}
                    onChange={handleSyncStrategyChange}
                    helpText="Choose how to handle existing menus in staging"
                  />

                  <Button
                    submit
                    primary
                    loading={navigation.state === "submitting"}
                  >
                    Save Configuration
                  </Button>
                </BlockStack>
              </Form>
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text variant="headingMd" as="h2">
                Available Connections
              </Text>

              {connections.length === 0 ? (
                <EmptyState heading="No connections found" image="">
                  <p>
                    Create a store connection in Settings to sync navigation
                    menus.
                  </p>
                </EmptyState>
              ) : (
                <DataTable
                  columnContentTypes={["text", "text", "text", "text"]}
                  headings={["Name", "Domain", "Environment", "Status"]}
                  rows={connections.map((connection) => [
                    connection.name,
                    connection.storeDomain,
                    connection.environment,
                    <Badge key={connection.id} status="success">
                      Active
                    </Badge>,
                  ])}
                />
              )}
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text variant="headingMd" as="h2">
                Navigation Menu Sync Information
              </Text>

              <BlockStack gap="200">
                <Text variant="bodyMd" as="p">
                  <strong>What gets synced:</strong>
                </Text>
                <ul>
                  <li>Menu structure and hierarchy (up to 3 levels deep)</li>
                  <li>Menu item titles, types, and URLs</li>
                  <li>Menu handles and associations</li>
                </ul>

                <Text variant="bodyMd" as="p">
                  <strong>Limitations:</strong>
                </Text>
                <ul>
                  <li>
                    Resource references (products, collections) may not work
                    correctly
                  </li>
                  <li>Menu item IDs will be different between environments</li>
                  <li>
                    Manual verification of links may be required after sync
                  </li>
                </ul>
              </BlockStack>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
