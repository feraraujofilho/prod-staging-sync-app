import { useState, useCallback, useEffect } from "react";
import {
  useLoaderData,
  useActionData,
  useNavigation,
  useSubmit,
} from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  BlockStack,
  InlineStack,
  Text,
  Button,
  Banner,
  Badge,
  Select,
  Checkbox,
  Box,
  EmptyState,
  Divider,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import {
  reloadSchedule,
  removeSchedule,
  runScheduleNow,
  calculateNextRunAt,
} from "../services/scheduler.server";

const SYNC_TYPE_LABELS = {
  metafield_definitions: "Metafield Definitions",
  metaobject_definitions: "Metaobject Definitions",
  products: "Products",
  collections: "Collections",
  locations: "Locations",
  navigation: "Navigation Menus",
  pages: "Pages",
  files: "Files",
  markets: "Markets",
  search_discovery: "Search & Discovery",
};

const FREQUENCY_OPTIONS = [
  { label: "Daily", value: "daily" },
  { label: "Every 12 hours", value: "every_12h" },
  { label: "Every 6 hours", value: "every_6h" },
  { label: "Weekly", value: "weekly" },
];

const HOUR_OPTIONS = Array.from({ length: 24 }, (_, i) => ({
  label: `${String(i).padStart(2, "0")}:00 UTC`,
  value: String(i),
}));

const DAY_OPTIONS = [
  { label: "Sunday", value: "0" },
  { label: "Monday", value: "1" },
  { label: "Tuesday", value: "2" },
  { label: "Wednesday", value: "3" },
  { label: "Thursday", value: "4" },
  { label: "Friday", value: "5" },
  { label: "Saturday", value: "6" },
];

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);

  const connections = await prisma.storeConnection.findMany({
    where: { shop: session.shop, isActive: true },
    select: { id: true, name: true, storeDomain: true },
  });

  const schedules = await prisma.syncSchedule.findMany({
    where: { shop: session.shop },
    include: {
      connection: {
        select: { name: true, storeDomain: true },
      },
    },
    orderBy: { createdAt: "desc" },
  });

  return { connections, schedules };
};

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const actionType = formData.get("action");

  try {
    switch (actionType) {
      case "create":
      case "update": {
        const connectionId = formData.get("connectionId");
        const syncTypes = formData.getAll("syncTypes");
        const frequency = formData.get("frequency") || "daily";
        const hour = parseInt(formData.get("hour") || "2", 10);
        const minute = parseInt(formData.get("minute") || "0", 10);
        const dayOfWeek = formData.get("dayOfWeek")
          ? parseInt(formData.get("dayOfWeek"), 10)
          : null;

        if (!connectionId) {
          return { error: "Please select a connection", success: false };
        }

        if (syncTypes.length === 0) {
          return { error: "Please select at least one sync type", success: false };
        }

        // Verify connection belongs to this shop
        const connection = await prisma.storeConnection.findUnique({
          where: { id: connectionId },
        });
        if (!connection || connection.shop !== session.shop) {
          return { error: "Invalid connection", success: false };
        }

        const scheduleData = {
          shop: session.shop,
          connectionId,
          syncTypes: JSON.stringify(syncTypes),
          frequency,
          hour,
          minute,
          dayOfWeek: frequency === "weekly" ? dayOfWeek : null,
          enabled: true,
        };

        // Calculate next run
        scheduleData.nextRunAt = calculateNextRunAt(scheduleData);

        // Upsert by connectionId (one schedule per connection)
        await prisma.syncSchedule.upsert({
          where: { connectionId },
          create: scheduleData,
          update: scheduleData,
        });

        // Reload the cron task
        await reloadSchedule(connectionId);

        return {
          success: true,
          message: actionType === "create"
            ? "Schedule created successfully"
            : "Schedule updated successfully",
        };
      }

      case "toggle": {
        const id = formData.get("id");
        const schedule = await prisma.syncSchedule.findUnique({
          where: { id },
        });
        if (!schedule || schedule.shop !== session.shop) {
          return { error: "Schedule not found", success: false };
        }

        const newEnabled = !schedule.enabled;
        const updateData = { enabled: newEnabled };

        if (newEnabled) {
          updateData.nextRunAt = calculateNextRunAt(schedule);
        } else {
          updateData.nextRunAt = null;
        }

        await prisma.syncSchedule.update({
          where: { id },
          data: updateData,
        });

        await reloadSchedule(schedule.connectionId);

        return {
          success: true,
          message: newEnabled ? "Schedule enabled" : "Schedule paused",
        };
      }

      case "delete": {
        const id = formData.get("id");
        const schedule = await prisma.syncSchedule.findUnique({
          where: { id },
        });
        if (!schedule || schedule.shop !== session.shop) {
          return { error: "Schedule not found", success: false };
        }

        await removeSchedule(schedule.connectionId);
        await prisma.syncSchedule.delete({ where: { id } });

        return { success: true, message: "Schedule deleted" };
      }

      case "run_now": {
        const connectionId = formData.get("connectionId");
        const schedule = await prisma.syncSchedule.findUnique({
          where: { connectionId },
        });
        if (!schedule || schedule.shop !== session.shop) {
          return { error: "Schedule not found", success: false };
        }

        await runScheduleNow(connectionId);

        return { success: true, message: "Sync started! Check the Data Sync page for progress." };
      }

      default:
        return { error: "Invalid action", success: false };
    }
  } catch (error) {
    console.error("Schedule action error:", error);
    return { error: error.message || "An error occurred", success: false };
  }
};

export default function Schedule() {
  const { connections, schedules } = useLoaderData();
  const actionData = useActionData();
  const navigation = useNavigation();
  const submit = useSubmit();

  const isLoading = navigation.state === "submitting";

  // Form state
  const [selectedConnection, setSelectedConnection] = useState("");
  const [selectedSyncTypes, setSelectedSyncTypes] = useState([
    "metafield_definitions",
    "metaobject_definitions",
    "products",
    "collections",
  ]);
  const [frequency, setFrequency] = useState("daily");
  const [hour, setHour] = useState("2");
  const [dayOfWeek, setDayOfWeek] = useState("0");
  const [isEditing, setIsEditing] = useState(false);

  // Populate form when editing
  const handleEdit = useCallback((schedule) => {
    setSelectedConnection(schedule.connectionId);
    setSelectedSyncTypes(JSON.parse(schedule.syncTypes));
    setFrequency(schedule.frequency);
    setHour(String(schedule.hour));
    setDayOfWeek(String(schedule.dayOfWeek ?? 0));
    setIsEditing(true);
  }, []);

  const handleCancel = useCallback(() => {
    setSelectedConnection("");
    setSelectedSyncTypes([
      "metafield_definitions",
      "metaobject_definitions",
      "products",
      "collections",
    ]);
    setFrequency("daily");
    setHour("2");
    setDayOfWeek("0");
    setIsEditing(false);
  }, []);

  // Reset form after successful action
  useEffect(() => {
    if (actionData?.success) {
      handleCancel();
    }
  }, [actionData, handleCancel]);

  const handleSyncTypeToggle = useCallback(
    (syncType) => {
      setSelectedSyncTypes((prev) =>
        prev.includes(syncType)
          ? prev.filter((t) => t !== syncType)
          : [...prev, syncType],
      );
    },
    [],
  );

  const handleSave = useCallback(() => {
    const formData = new FormData();
    formData.append("action", isEditing ? "update" : "create");
    formData.append("connectionId", selectedConnection);
    formData.append("frequency", frequency);
    formData.append("hour", hour);
    formData.append("minute", "0");
    formData.append("dayOfWeek", dayOfWeek);
    selectedSyncTypes.forEach((t) => formData.append("syncTypes", t));
    submit(formData, { method: "post" });
  }, [isEditing, selectedConnection, frequency, hour, dayOfWeek, selectedSyncTypes, submit]);

  const handleToggle = useCallback(
    (schedule) => {
      const formData = new FormData();
      formData.append("action", "toggle");
      formData.append("id", schedule.id);
      submit(formData, { method: "post" });
    },
    [submit],
  );

  const handleDelete = useCallback(
    (schedule) => {
      const formData = new FormData();
      formData.append("action", "delete");
      formData.append("id", schedule.id);
      submit(formData, { method: "post" });
    },
    [submit],
  );

  const handleRunNow = useCallback(
    (schedule) => {
      const formData = new FormData();
      formData.append("action", "run_now");
      formData.append("connectionId", schedule.connectionId);
      submit(formData, { method: "post" });
    },
    [submit],
  );

  const connectionOptions = [
    { label: "Select a connection...", value: "" },
    ...connections.map((c) => ({
      label: `${c.name} (${c.storeDomain})`,
      value: c.id,
    })),
  ];

  // Check which connections already have schedules
  const scheduledConnectionIds = new Set(schedules.map((s) => s.connectionId));

  // Only show connections without schedules in the create form (unless editing)
  const availableConnections = isEditing
    ? connectionOptions
    : [
        { label: "Select a connection...", value: "" },
        ...connections
          .filter((c) => !scheduledConnectionIds.has(c.id))
          .map((c) => ({
            label: `${c.name} (${c.storeDomain})`,
            value: c.id,
          })),
      ];

  function formatLastRun(schedule) {
    if (!schedule.lastRunAt) return "Never";
    const date = new Date(schedule.lastRunAt);
    return date.toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      timeZoneName: "short",
    });
  }

  function formatNextRun(schedule) {
    if (!schedule.nextRunAt || !schedule.enabled) return "—";
    const date = new Date(schedule.nextRunAt);
    return date.toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      timeZoneName: "short",
    });
  }

  function frequencyLabel(freq) {
    return FREQUENCY_OPTIONS.find((o) => o.value === freq)?.label || freq;
  }

  function statusBadge(status) {
    if (!status) return null;
    const toneMap = {
      success: "success",
      partial: "warning",
      failed: "critical",
    };
    return (
      <Badge tone={toneMap[status] || "default"}>
        {status}
      </Badge>
    );
  }

  const hasUnscheduledConnections = connections.some(
    (c) => !scheduledConnectionIds.has(c.id),
  );

  return (
    <Page title="Scheduled Syncs" backAction={{ url: "/app/sync" }}>
      <Layout>
        {actionData?.error && (
          <Layout.Section>
            <Banner tone="critical">{actionData.error}</Banner>
          </Layout.Section>
        )}
        {actionData?.success && (
          <Layout.Section>
            <Banner tone="success" onDismiss={() => {}}>
              {actionData.message}
            </Banner>
          </Layout.Section>
        )}

        {/* Existing schedules */}
        <Layout.Section>
          <Text variant="headingLg" as="h2">
            Active Schedules
          </Text>
          <Box paddingBlockStart="300">
            {schedules.length === 0 ? (
              <Card>
                <EmptyState
                  heading="No scheduled syncs yet"
                  image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
                >
                  <p>
                    Set up automatic syncs to keep your staging store up to date.
                    Configure a schedule below.
                  </p>
                </EmptyState>
              </Card>
            ) : (
              <BlockStack gap="400">
                {schedules.map((schedule) => (
                  <Card key={schedule.id}>
                    <BlockStack gap="300">
                      <InlineStack align="space-between" blockAlign="center">
                        <InlineStack gap="300" blockAlign="center">
                          <Text variant="headingMd" as="h3">
                            {schedule.connection.name}
                          </Text>
                          <Badge tone={schedule.enabled ? "success" : "default"}>
                            {schedule.enabled ? "Active" : "Paused"}
                          </Badge>
                          {statusBadge(schedule.lastRunStatus)}
                        </InlineStack>
                        <InlineStack gap="200">
                          <Button
                            size="slim"
                            onClick={() => handleRunNow(schedule)}
                            loading={isLoading}
                          >
                            Run Now
                          </Button>
                          <Button
                            size="slim"
                            onClick={() => handleEdit(schedule)}
                          >
                            Edit
                          </Button>
                          <Button
                            size="slim"
                            tone={schedule.enabled ? "default" : "success"}
                            onClick={() => handleToggle(schedule)}
                            loading={isLoading}
                          >
                            {schedule.enabled ? "Pause" : "Resume"}
                          </Button>
                          <Button
                            size="slim"
                            tone="critical"
                            onClick={() => handleDelete(schedule)}
                            loading={isLoading}
                          >
                            Delete
                          </Button>
                        </InlineStack>
                      </InlineStack>

                      <Divider />

                      <InlineStack gap="600">
                        <BlockStack gap="100">
                          <Text variant="bodySm" tone="subdued">Frequency</Text>
                          <Text variant="bodyMd">
                            {frequencyLabel(schedule.frequency)}
                            {schedule.frequency !== "every_6h" && schedule.frequency !== "every_12h"
                              ? ` at ${String(schedule.hour).padStart(2, "0")}:${String(schedule.minute).padStart(2, "0")} UTC`
                              : ""}
                          </Text>
                        </BlockStack>
                        <BlockStack gap="100">
                          <Text variant="bodySm" tone="subdued">Sync Types</Text>
                          <InlineStack gap="100">
                            {JSON.parse(schedule.syncTypes).map((t) => (
                              <Badge key={t} tone="info">
                                {SYNC_TYPE_LABELS[t] || t}
                              </Badge>
                            ))}
                          </InlineStack>
                        </BlockStack>
                      </InlineStack>

                      <InlineStack gap="600">
                        <BlockStack gap="100">
                          <Text variant="bodySm" tone="subdued">Last Run</Text>
                          <Text variant="bodyMd">{formatLastRun(schedule)}</Text>
                        </BlockStack>
                        <BlockStack gap="100">
                          <Text variant="bodySm" tone="subdued">Next Run</Text>
                          <Text variant="bodyMd">{formatNextRun(schedule)}</Text>
                        </BlockStack>
                      </InlineStack>

                      {schedule.lastRunSummary && (
                        <>
                          <Divider />
                          <BlockStack gap="100">
                            <Text variant="bodySm" tone="subdued">Last Run Summary</Text>
                            <Box padding="200" background="bg-surface-secondary" borderRadius="200">
                              <LastRunSummary summary={schedule.lastRunSummary} />
                            </Box>
                          </BlockStack>
                        </>
                      )}
                    </BlockStack>
                  </Card>
                ))}
              </BlockStack>
            )}
          </Box>
        </Layout.Section>

        {/* Create/Edit schedule form */}
        {(hasUnscheduledConnections || isEditing) && (
          <Layout.Section>
            <Card>
              <BlockStack gap="400">
                <Text variant="headingMd" as="h2">
                  {isEditing ? "Edit Schedule" : "Create New Schedule"}
                </Text>

                <Select
                  label="Store Connection"
                  options={availableConnections}
                  value={selectedConnection}
                  onChange={setSelectedConnection}
                  disabled={isEditing}
                />

                <BlockStack gap="200">
                  <Text variant="bodyMd" fontWeight="semibold">
                    Sync Types
                  </Text>
                  <InlineStack gap="400" wrap>
                    {Object.entries(SYNC_TYPE_LABELS).map(([key, label]) => (
                      <Checkbox
                        key={key}
                        label={label}
                        checked={selectedSyncTypes.includes(key)}
                        onChange={() => handleSyncTypeToggle(key)}
                      />
                    ))}
                  </InlineStack>
                </BlockStack>

                <InlineStack gap="400">
                  <Box minWidth="200px">
                    <Select
                      label="Frequency"
                      options={FREQUENCY_OPTIONS}
                      value={frequency}
                      onChange={setFrequency}
                    />
                  </Box>

                  {(frequency === "daily" || frequency === "weekly") && (
                    <Box minWidth="200px">
                      <Select
                        label="Time (UTC)"
                        options={HOUR_OPTIONS}
                        value={hour}
                        onChange={setHour}
                      />
                    </Box>
                  )}

                  {frequency === "weekly" && (
                    <Box minWidth="200px">
                      <Select
                        label="Day of Week"
                        options={DAY_OPTIONS}
                        value={dayOfWeek}
                        onChange={setDayOfWeek}
                      />
                    </Box>
                  )}
                </InlineStack>

                <InlineStack gap="200">
                  <Button
                    variant="primary"
                    onClick={handleSave}
                    loading={isLoading}
                    disabled={!selectedConnection || selectedSyncTypes.length === 0}
                  >
                    {isEditing ? "Update Schedule" : "Create Schedule"}
                  </Button>
                  {isEditing && (
                    <Button onClick={handleCancel}>Cancel</Button>
                  )}
                </InlineStack>
              </BlockStack>
            </Card>
          </Layout.Section>
        )}

        {/* Info card */}
        <Layout.Section>
          <Card>
            <BlockStack gap="200">
              <Text variant="headingMd" as="h2">
                About Scheduled Syncs
              </Text>
              <Text variant="bodyMd" as="p">
                Scheduled syncs run automatically in the background. Each sync
                type runs sequentially to avoid overwhelming the Shopify API.
                All times are in UTC.
              </Text>
              <Text variant="bodyMd" as="p">
                Sync results are logged and visible on the Data Sync page. If a
                scheduled sync fails, it will be retried on the next scheduled
                run.
              </Text>
              <Text variant="bodySm" tone="subdued" as="p">
                Note: The scheduler runs in-process. If the app is restarted,
                schedules are automatically reloaded.
              </Text>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}

function LastRunSummary({ summary }) {
  try {
    const data = JSON.parse(summary);
    if (data.error) {
      return <Text variant="bodySm" tone="critical">{data.error}</Text>;
    }
    if (data.results) {
      return (
        <BlockStack gap="100">
          {data.duration && (
            <Text variant="bodySm">Duration: {data.duration}</Text>
          )}
          {data.results.map((r, i) => (
            <Text key={i} variant="bodySm">
              {SYNC_TYPE_LABELS[r.syncType] || r.syncType}: {r.status}
              {r.created != null ? ` (created: ${r.created}, updated: ${r.updated}, failed: ${r.failed ?? 0})` : ""}
            </Text>
          ))}
        </BlockStack>
      );
    }
    return <Text variant="bodySm">{summary}</Text>;
  } catch {
    return <Text variant="bodySm">{summary}</Text>;
  }
}
