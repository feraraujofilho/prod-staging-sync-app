import { useState, useCallback, useEffect } from "react";
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
  Text,
  Button,
  Banner,
  Badge,
  InlineStack,
  EmptyState,
  Tabs,
  Select,
  ProgressBar,
  DataTable,
  Scrollable,
  Icon,
  Box,
  Divider,
  List,
  Modal,
} from "@shopify/polaris";
import {
  RefreshIcon,
  ProductIcon,
  CollectionIcon,
  ProfileIcon,
  OrderIcon,
  SettingsIcon,
  ImportIcon,
} from "@shopify/polaris-icons";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { syncMetafieldDefinitions } from "../services/sync.metafields.server";
import { syncMetaobjectDefinitions } from "../services/sync.metaobjects.server";

// Loader to fetch connections and recent sync logs
export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);

  const connections = await prisma.storeConnection.findMany({
    where: {
      shop: session.shop,
      isActive: true,
    },
    select: {
      id: true,
      name: true,
      storeDomain: true,
      environment: true,
    },
  });

  const recentLogs = await prisma.syncLog.findMany({
    where: { shop: session.shop },
    orderBy: { startedAt: "desc" },
    take: 10,
    include: {
      connection: {
        select: {
          name: true,
          storeDomain: true,
        },
      },
    },
  });

  return { connections, recentLogs };
};

// Action handler for sync operations
export const action = async ({ request }) => {
  // const { decrypt } = await import("../utils/encryption.server");
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();

  const syncType = formData.get("syncType");
  const connectionId = formData.get("connectionId");

  if (!connectionId) {
    return { error: "Please select a connection" };
  }

  // Fetch connection with decrypted token
  const connection = await prisma.storeConnection.findUnique({
    where: { id: connectionId },
  });

  if (!connection || connection.shop !== session.shop) {
    return { error: "Invalid connection" };
  }

  const decryptedToken = connection.encryptedToken;
  console.log("decryptedToken", decryptedToken);
  // Check if token decryption failed
  if (!decryptedToken) {
    return {
      error:
        "Failed to decrypt access token. The encryption key may have changed. Please go to Settings and update this connection with a new access token.",
    };
  }

  // Create sync log entry
  const syncLog = await prisma.syncLog.create({
    data: {
      shop: session.shop,
      connectionId: connection.id,
      syncType,
      status: "in_progress",
      startedAt: new Date(),
    },
  });

  try {
    let result;

    switch (syncType) {
      case "metafield_definitions":
        result = await syncMetafieldDefinitions(
          connection.storeDomain,
          decryptedToken,
          admin,
        );
        break;

      case "metaobject_definitions":
        result = await syncMetaobjectDefinitions(
          connection.storeDomain,
          decryptedToken,
          admin,
        );
        break;

      case "products":
        // TODO: Implement product sync
        result = {
          success: false,
          error: "Product sync not yet implemented",
        };
        break;

      case "collections":
        // TODO: Implement collection sync
        result = {
          success: false,
          error: "Collection sync not yet implemented",
        };
        break;

      default:
        result = {
          success: false,
          error: "Invalid sync type",
        };
    }

    // Update sync log with results
    await prisma.syncLog.update({
      where: { id: syncLog.id },
      data: {
        status: result.success ? "success" : "failed",
        summary: JSON.stringify(result.summary || {}),
        logs: JSON.stringify(result.logs || []),
        completedAt: new Date(),
      },
    });

    return result;
  } catch (error) {
    // Update sync log with error
    await prisma.syncLog.update({
      where: { id: syncLog.id },
      data: {
        status: "failed",
        summary: JSON.stringify({ error: error.message }),
        completedAt: new Date(),
      },
    });

    return {
      success: false,
      error: error.message,
    };
  }
};

// Sync type configurations
const SYNC_TYPES = [
  {
    id: "metafield_definitions",
    label: "Metafield Definitions",
    description: "Sync product metafield structures between stores",
    icon: SettingsIcon,
    available: true,
  },
  {
    id: "metaobject_definitions",
    label: "Metaobject Definitions",
    description: "Sync metaobject definitions between stores",
    icon: ImportIcon,
    available: true,
  },
  {
    id: "products",
    label: "Products",
    description: "Sync product catalog including variants and images",
    icon: ProductIcon,
    available: false,
  },
  {
    id: "collections",
    label: "Collections",
    description: "Sync collections and their product associations",
    icon: CollectionIcon,
    available: false,
  },
  {
    id: "customers",
    label: "Customers",
    description: "Sync customer data and segments",
    icon: ProfileIcon,
    available: false,
  },
  {
    id: "orders",
    label: "Orders",
    description: "Sync order history and fulfillment data",
    icon: OrderIcon,
    available: false,
  },
];

export default function DataSync() {
  const { connections, recentLogs } = useLoaderData();
  const actionData = useActionData();
  const navigation = useNavigation();
  const submit = useSubmit();

  const [selectedTab, setSelectedTab] = useState(0);
  const [selectedConnection, setSelectedConnection] = useState("");
  const [showLogs, setShowLogs] = useState(false);
  const [selectedLogId, setSelectedLogId] = useState(null);
  const [selectedLogDetails, setSelectedLogDetails] = useState(null);

  const isLoading = navigation.state === "submitting";

  // Auto-show logs when sync completes
  useEffect(() => {
    if (actionData?.logs && actionData?.success !== undefined) {
      setShowLogs(true);
    }
  }, [actionData]);

  const handleTabChange = useCallback(
    (selectedTabIndex) => setSelectedTab(selectedTabIndex),
    [],
  );

  const handleSync = useCallback(
    (syncType) => {
      if (!selectedConnection) {
        return;
      }

      const formData = new FormData();
      formData.append("syncType", syncType);
      formData.append("connectionId", selectedConnection);
      submit(formData, { method: "post" });
    },
    [selectedConnection, submit],
  );

  const handleViewLog = useCallback((log) => {
    // Parse the logs and summary from JSON
    try {
      const logs = log.logs ? JSON.parse(log.logs) : [];
      let summary = {};

      // Handle different formats of summary data
      if (log.summary) {
        try {
          // First try to parse as JSON
          summary = JSON.parse(log.summary);
        } catch (e) {
          // If parsing fails, check if it's a string that needs to be converted
          if (typeof log.summary === "string") {
            // Check if it's a formatted string like "Total: 15, Created: 0, ..."
            const summaryMatch = log.summary.match(/(\w+):\s*(\d+)/g);
            if (summaryMatch) {
              summary = {};
              summaryMatch.forEach((match) => {
                const [key, value] = match.split(":").map((s) => s.trim());
                summary[key.toLowerCase()] = parseInt(value) || value;
              });
            } else {
              // If it's just a plain string, store it as error message
              summary = { message: log.summary };
            }
          }
        }
      }

      setSelectedLogDetails({
        ...log,
        parsedLogs: logs,
        parsedSummary: summary,
      });
      setSelectedLogId(log.id);
    } catch (error) {
      console.error("Error parsing log data:", error);
      // Still show the modal with what we can parse
      setSelectedLogDetails({
        ...log,
        parsedLogs: [],
        parsedSummary: { error: "Failed to parse log data" },
      });
      setSelectedLogId(log.id);
    }
  }, []);

  const connectionOptions = [
    { label: "Select a connection", value: "" },
    ...connections.map((conn) => ({
      label: `${conn.name} (${conn.storeDomain})`,
      value: conn.id,
    })),
  ];

  const tabs = [
    {
      id: "overview",
      content: "Overview",
      panelID: "overview-panel",
    },
    {
      id: "history",
      content: "Sync History",
      panelID: "history-panel",
    },
  ];

  return (
    <Page
      title="Data Sync"
      subtitle="Synchronize data between your Shopify stores"
      primaryAction={
        connections.length === 0
          ? {
              content: "Add Connection",
              url: "/app/settings",
            }
          : undefined
      }
    >
      <Layout>
        {actionData?.error && (
          <Layout.Section>
            <Banner status="critical">{actionData.error}</Banner>
          </Layout.Section>
        )}

        {actionData?.success && (
          <Layout.Section>
            <Banner
              status="success"
              title="Sync completed successfully"
              onDismiss={() => {}}
            >
              {actionData.summary && (
                <BlockStack gap="200">
                  {(() => {
                    try {
                      // Parse summary if it's a string
                      const summaryData =
                        typeof actionData.summary === "string"
                          ? JSON.parse(actionData.summary)
                          : actionData.summary;

                      // Only show numeric values from the summary
                      const relevantKeys = [
                        "total",
                        "existing",
                        "created",
                        "skipped",
                        "failed",
                        "reserved",
                        "updated",
                        "updateFailed",
                      ];

                      return Object.entries(summaryData)
                        .filter(([key]) => relevantKeys.includes(key))
                        .map(([key, value]) => (
                          <Text key={key} variant="bodyMd">
                            {key
                              .replace(/_/g, " ")
                              .replace(/\b\w/g, (l) => l.toUpperCase())}
                            : {value}
                          </Text>
                        ));
                    } catch (error) {
                      console.error("Error parsing summary:", error);
                      return (
                        <Text variant="bodyMd">
                          Sync completed successfully
                        </Text>
                      );
                    }
                  })()}
                </BlockStack>
              )}
            </Banner>
          </Layout.Section>
        )}

        {connections.length === 0 ? (
          <Layout.Section>
            <EmptyState
              heading="No active connections"
              action={{
                content: "Add a connection",
                url: "/app/settings",
              }}
              secondaryAction={{
                content: "Learn more",
                url: "https://help.shopify.com",
              }}
              image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
            >
              <p>Connect to external Shopify stores to start syncing data.</p>
            </EmptyState>
          </Layout.Section>
        ) : (
          <>
            <Layout.Section>
              <Card>
                <BlockStack gap="400">
                  <Text variant="headingMd" as="h2">
                    Select Source Connection
                  </Text>
                  <Select
                    label="Source Store"
                    options={connectionOptions}
                    value={selectedConnection}
                    onChange={setSelectedConnection}
                    helpText="Choose which store to sync data from"
                  />
                </BlockStack>
              </Card>
            </Layout.Section>

            <Layout.Section>
              <Tabs
                tabs={tabs}
                selected={selectedTab}
                onSelect={handleTabChange}
              >
                <div style={{ paddingTop: "16px" }}>
                  {selectedTab === 0 && (
                    <Card>
                      <BlockStack gap="400">
                        <Text variant="headingMd" as="h2">
                          Available Sync Operations
                        </Text>

                        <BlockStack gap="300">
                          {SYNC_TYPES.map((syncType) => (
                            <Box
                              key={syncType.id}
                              padding="400"
                              borderRadius="200"
                              background={
                                syncType.available
                                  ? "bg-surface"
                                  : "bg-surface-disabled"
                              }
                            >
                              <InlineStack
                                gap="400"
                                align="space-between"
                                blockAlign="center"
                              >
                                <InlineStack gap="400" blockAlign="center">
                                  <Icon
                                    source={syncType.icon}
                                    color={
                                      syncType.available ? "base" : "subdued"
                                    }
                                  />
                                  <BlockStack gap="100">
                                    <Text
                                      variant="bodyMd"
                                      fontWeight="semibold"
                                    >
                                      {syncType.label}
                                    </Text>
                                    <Text variant="bodySm" color="subdued">
                                      {syncType.description}
                                    </Text>
                                  </BlockStack>
                                </InlineStack>

                                <Button
                                  primary={syncType.available}
                                  disabled={
                                    !syncType.available ||
                                    !selectedConnection ||
                                    isLoading
                                  }
                                  loading={
                                    isLoading &&
                                    navigation.formData?.get("syncType") ===
                                      syncType.id
                                  }
                                  onClick={() => handleSync(syncType.id)}
                                >
                                  {syncType.available ? (
                                    <>
                                      <Icon source={RefreshIcon} />
                                      Sync Now
                                    </>
                                  ) : (
                                    "Coming Soon"
                                  )}
                                </Button>
                              </InlineStack>
                            </Box>
                          ))}
                        </BlockStack>
                      </BlockStack>
                    </Card>
                  )}

                  {selectedTab === 1 && (
                    <Card>
                      <BlockStack gap="400">
                        <Text variant="headingMd" as="h2">
                          Recent Sync History
                        </Text>

                        {recentLogs.length === 0 ? (
                          <EmptyState
                            heading="No sync history yet"
                            image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
                          >
                            <p>
                              Your sync history will appear here after running
                              sync operations.
                            </p>
                          </EmptyState>
                        ) : (
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
                              "Type",
                              "Source",
                              "Status",
                              "Started",
                              "Duration",
                              "Actions",
                            ]}
                            rows={recentLogs.map((log) => {
                              const duration = log.completedAt
                                ? Math.round(
                                    (new Date(log.completedAt) -
                                      new Date(log.startedAt)) /
                                      1000,
                                  )
                                : null;

                              return [
                                log.syncType
                                  .replace(/_/g, " ")
                                  .replace(/\b\w/g, (l) => l.toUpperCase()),
                                log.connection.name,
                                <Badge
                                  status={
                                    log.status === "success"
                                      ? "success"
                                      : log.status === "failed"
                                        ? "critical"
                                        : "info"
                                  }
                                >
                                  {log.status}
                                </Badge>,
                                new Date(log.startedAt).toLocaleString(),
                                duration ? `${duration}s` : "In progress",
                                <Button
                                  plain
                                  onClick={() => {
                                    handleViewLog(log);
                                  }}
                                >
                                  View Logs
                                </Button>,
                              ];
                            })}
                          />
                        )}
                      </BlockStack>
                    </Card>
                  )}
                </div>
              </Tabs>
            </Layout.Section>

            {actionData?.logs && showLogs && (
              <Layout.Section>
                <Card>
                  <BlockStack gap="400">
                    <InlineStack align="space-between">
                      <Text variant="headingMd" as="h2">
                        Sync Logs
                      </Text>
                      <Button plain onClick={() => setShowLogs(false)}>
                        Hide Logs
                      </Button>
                    </InlineStack>

                    <Scrollable style={{ height: "400px" }}>
                      <BlockStack gap="100">
                        {actionData.logs.map((log, index) => (
                          <Box key={index} padding="200">
                            <Text
                              variant="bodySm"
                              color={
                                log.error || log.message?.includes("❌")
                                  ? "critical"
                                  : log.success || log.message?.includes("✅")
                                    ? "success"
                                    : log.skipped || log.message?.includes("⚠️")
                                      ? "caution"
                                      : "subdued"
                              }
                            >
                              [{log.timestamp}] {log.message}
                            </Text>
                          </Box>
                        ))}
                      </BlockStack>
                    </Scrollable>
                  </BlockStack>
                </Card>
              </Layout.Section>
            )}
          </>
        )}
      </Layout>

      {/* Modal for viewing historical log details */}
      <Modal
        open={!!selectedLogId}
        onClose={() => {
          setSelectedLogId(null);
          setSelectedLogDetails(null);
        }}
        title="Sync Log Details"
        large
        secondaryActions={[
          {
            content: "Close",
            onAction: () => {
              setSelectedLogId(null);
              setSelectedLogDetails(null);
            },
          },
        ]}
      >
        <Modal.Section>
          {selectedLogDetails && (
            <BlockStack gap="400">
              <BlockStack gap="200">
                <InlineStack gap="400">
                  <Text variant="bodyMd" fontWeight="semibold">
                    Type:
                  </Text>
                  <Text variant="bodyMd">
                    {selectedLogDetails.syncType
                      .replace(/_/g, " ")
                      .replace(/\b\w/g, (l) => l.toUpperCase())}
                  </Text>
                </InlineStack>
                <InlineStack gap="400">
                  <Text variant="bodyMd" fontWeight="semibold">
                    Source:
                  </Text>
                  <Text variant="bodyMd">
                    {selectedLogDetails.connection.name}
                  </Text>
                </InlineStack>
                <InlineStack gap="400">
                  <Text variant="bodyMd" fontWeight="semibold">
                    Status:
                  </Text>
                  <Badge
                    status={
                      selectedLogDetails.status === "success"
                        ? "success"
                        : selectedLogDetails.status === "failed"
                          ? "critical"
                          : "info"
                    }
                  >
                    {selectedLogDetails.status}
                  </Badge>
                </InlineStack>
                <InlineStack gap="400">
                  <Text variant="bodyMd" fontWeight="semibold">
                    Started:
                  </Text>
                  <Text variant="bodyMd">
                    {new Date(selectedLogDetails.startedAt).toLocaleString()}
                  </Text>
                </InlineStack>
                {selectedLogDetails.completedAt && (
                  <InlineStack gap="400">
                    <Text variant="bodyMd" fontWeight="semibold">
                      Completed:
                    </Text>
                    <Text variant="bodyMd">
                      {new Date(
                        selectedLogDetails.completedAt,
                      ).toLocaleString()}
                    </Text>
                  </InlineStack>
                )}
              </BlockStack>

              {selectedLogDetails.parsedSummary &&
                Object.keys(selectedLogDetails.parsedSummary).length > 0 && (
                  <Card>
                    <BlockStack gap="300">
                      <Text variant="headingMd" as="h3">
                        Summary
                      </Text>
                      <BlockStack gap="200">
                        {(() => {
                          const summary = selectedLogDetails.parsedSummary;

                          // Check if summary is actually a string that was incorrectly parsed
                          if (typeof summary === "string") {
                            return <Text variant="bodyMd">{summary}</Text>;
                          }

                          // Filter out numeric keys (which would indicate string indices)
                          const validEntries = Object.entries(summary).filter(
                            ([key]) => isNaN(parseInt(key)),
                          );

                          if (validEntries.length === 0) {
                            return (
                              <Text variant="bodyMd" color="subdued">
                                No summary data available
                              </Text>
                            );
                          }

                          return validEntries.map(([key, value]) => {
                            // Special formatting for specific keys
                            let displayKey = key;
                            if (key === "updateFailed") {
                              displayKey = "Update Failed";
                            } else {
                              displayKey = key
                                .replace(/_/g, " ")
                                .replace(/\b\w/g, (l) => l.toUpperCase());
                            }

                            return (
                              <InlineStack key={key} gap="200">
                                <Text variant="bodyMd" fontWeight="semibold">
                                  {displayKey}:
                                </Text>
                                <Text variant="bodyMd">{value}</Text>
                              </InlineStack>
                            );
                          });
                        })()}
                      </BlockStack>
                    </BlockStack>
                  </Card>
                )}

              {selectedLogDetails.parsedLogs &&
                selectedLogDetails.parsedLogs.length > 0 && (
                  <Card>
                    <BlockStack gap="300">
                      <Text variant="headingMd" as="h3">
                        Detailed Logs
                      </Text>
                      <Scrollable style={{ height: "400px" }}>
                        <BlockStack gap="100">
                          {selectedLogDetails.parsedLogs.map((log, index) => (
                            <Box key={index} padding="200">
                              <Text
                                variant="bodySm"
                                color={
                                  log.error || log.message?.includes("❌")
                                    ? "critical"
                                    : log.success || log.message?.includes("✅")
                                      ? "success"
                                      : log.skipped ||
                                          log.message?.includes("⚠️")
                                        ? "caution"
                                        : "subdued"
                                }
                              >
                                [{log.timestamp}] {log.message}
                              </Text>
                            </Box>
                          ))}
                        </BlockStack>
                      </Scrollable>
                    </BlockStack>
                  </Card>
                )}
            </BlockStack>
          )}
        </Modal.Section>
      </Modal>
    </Page>
  );
}
