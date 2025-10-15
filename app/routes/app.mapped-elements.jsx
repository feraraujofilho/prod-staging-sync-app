import { useState, useCallback } from "react";
import { useLoaderData, useFetcher, useNavigate } from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  BlockStack,
  Text,
  DataTable,
  Tabs,
  EmptyState,
  Badge,
  InlineStack,
  Button,
  TextField,
  Select,
  Banner,
  Box,
} from "@shopify/polaris";
import { SearchIcon, RefreshIcon } from "@shopify/polaris-icons";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import {
  getMappings,
  getMappingsCount,
  getUnmappedReferencesCount,
  getMappingStats,
} from "../services/resource-mapping.server";

// Loader to fetch mappings and stats
export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);

  const resourceType = url.searchParams.get("type") || "product";
  const page = parseInt(url.searchParams.get("page") || "1");
  const limit = 50;
  const offset = (page - 1) * limit;

  // Get active connections
  const connections = await prisma.storeConnection.findMany({
    where: {
      shop: session.shop,
      isActive: true,
    },
    select: {
      id: true,
      name: true,
      storeDomain: true,
    },
  });

  if (connections.length === 0) {
    return {
      connections: [],
      mappings: [],
      stats: null,
      totalMappings: 0,
      totalUnmapped: 0,
      resourceType,
      page,
      totalPages: 0,
    };
  }

  // Use the first active connection
  const connectionId = connections[0].id;

  // Get mappings for selected resource type
  const mappings = await getMappings(connectionId, resourceType, {
    limit,
    offset,
  });

  // Get total count for pagination
  const totalMappings = await getMappingsCount(connectionId, resourceType);
  const totalPages = Math.ceil(totalMappings / limit);

  // Get unmapped references count
  const totalUnmapped = await getUnmappedReferencesCount(connectionId, {
    resolved: false,
  });

  // Get overall stats
  const stats = await getMappingStats(connectionId);

  return {
    connections,
    connectionId,
    mappings,
    stats,
    totalMappings,
    totalUnmapped,
    resourceType,
    page,
    totalPages,
  };
};

// Resource type configurations
const RESOURCE_TYPES = [
  { id: "product", label: "Products" },
  { id: "variant", label: "Product Variants" },
  { id: "collection", label: "Collections" },
  { id: "market", label: "Markets" },
  { id: "location", label: "Locations" },
  { id: "page", label: "Pages" },
  { id: "file", label: "Files" },
  { id: "metaobject", label: "Metaobjects" },
  { id: "navigation", label: "Navigation Menus" },
];

export default function MappedElements() {
  const {
    connections,
    connectionId,
    mappings,
    stats,
    totalMappings,
    totalUnmapped,
    resourceType,
    page,
    totalPages,
  } = useLoaderData();

  const navigate = useNavigate();
  const [searchQuery, setSearchQuery] = useState("");

  const handleResourceTypeChange = useCallback(
    (newType) => {
      navigate(`/app/mapped-elements?type=${newType}&page=1`);
    },
    [navigate],
  );

  const handlePageChange = useCallback(
    (newPage) => {
      navigate(`/app/mapped-elements?type=${resourceType}&page=${newPage}`);
    },
    [navigate, resourceType],
  );

  // Filter mappings based on search query
  const filteredMappings = mappings.filter((mapping) => {
    if (!searchQuery) return true;
    const query = searchQuery.toLowerCase();
    return (
      mapping.productionId?.includes(query) ||
      mapping.stagingId?.includes(query) ||
      mapping.matchKey?.toLowerCase().includes(query) ||
      mapping.matchValue?.toLowerCase().includes(query) ||
      mapping.title?.toLowerCase().includes(query) ||
      mapping.syncId?.toLowerCase().includes(query)
    );
  });

  // Prepare data table rows
  const tableRows = filteredMappings.map((mapping) => [
    <Text key={`prod-${mapping.id}`} variant="bodyMd" fontWeight="semibold">
      {mapping.productionId}
    </Text>,
    <Text key={`stag-${mapping.id}`} variant="bodyMd" fontWeight="semibold">
      {mapping.stagingId}
    </Text>,
    <Badge key={`match-${mapping.id}`} tone="info">
      {mapping.matchKey}
    </Badge>,
    <Text key={`value-${mapping.id}`} variant="bodyMd" breakWord>
      {mapping.matchValue}
    </Text>,
    mapping.title || "-",
    mapping.syncId || "-",
    new Date(mapping.lastSyncedAt).toLocaleDateString(),
  ]);

  if (connections.length === 0) {
    return (
      <Page title="Mapped Elements">
        <Layout>
          <Layout.Section>
            <EmptyState
              heading="No active connections"
              action={{
                content: "Add a connection",
                url: "/app/settings",
              }}
              image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
            >
              <p>
                Connect to external Shopify stores to start tracking resource
                mappings.
              </p>
            </EmptyState>
          </Layout.Section>
        </Layout>
      </Page>
    );
  }

  return (
    <Page
      title="Mapped Elements"
      subtitle="View and manage resource mappings between production and staging"
      backAction={{ content: "Data Sync", url: "/app/sync" }}
    >
      <Layout>
        {/* Stats Overview */}
        {stats && (
          <Layout.Section>
            <Card>
              <BlockStack gap="400">
                <Text variant="headingMd" as="h2">
                  Mapping Overview
                </Text>
                <InlineStack gap="400">
                  <Box
                    padding="400"
                    background="bg-surface-success-subdued"
                    borderRadius="200"
                  >
                    <BlockStack gap="100">
                      <Text variant="headingLg" as="p" fontWeight="bold">
                        {stats.totalMappings}
                      </Text>
                      <Text variant="bodyMd" color="subdued">
                        Total Mappings
                      </Text>
                    </BlockStack>
                  </Box>
                  {stats.totalUnmapped > 0 && (
                    <Box
                      padding="400"
                      background="bg-surface-warning-subdued"
                      borderRadius="200"
                    >
                      <BlockStack gap="100">
                        <Text variant="headingLg" as="p" fontWeight="bold">
                          {stats.totalUnmapped}
                        </Text>
                        <Text variant="bodyMd" color="subdued">
                          Unmapped References
                        </Text>
                      </BlockStack>
                    </Box>
                  )}
                </InlineStack>

                {/* Mappings by type */}
                <BlockStack gap="200">
                  <Text variant="bodyMd" fontWeight="semibold">
                    Mappings by Resource Type:
                  </Text>
                  <InlineStack gap="200" wrap>
                    {Object.entries(stats.mappingsByType).map(
                      ([type, count]) => (
                        <Badge key={type} tone="info">
                          {type}: {count}
                        </Badge>
                      ),
                    )}
                  </InlineStack>
                </BlockStack>
              </BlockStack>
            </Card>
          </Layout.Section>
        )}

        {/* Unmapped References Warning */}
        {totalUnmapped > 0 && (
          <Layout.Section>
            <Banner
              title="Unmapped References Found"
              status="warning"
              action={{
                content: "View Details",
                url: "/app/mapped-elements/unmapped",
              }}
            >
              <p>
                {totalUnmapped} resource reference
                {totalUnmapped !== 1 ? "s" : ""} could not be mapped during
                sync. These may cause broken references in metafield values.
              </p>
            </Banner>
          </Layout.Section>
        )}

        {/* Resource Type Selector */}
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <InlineStack align="space-between" blockAlign="center">
                <Text variant="headingMd" as="h2">
                  Select Resource Type
                </Text>
                <Button
                  icon={RefreshIcon}
                  onClick={() => window.location.reload()}
                >
                  Refresh
                </Button>
              </InlineStack>

              <Tabs
                tabs={RESOURCE_TYPES.map((type) => ({
                  id: type.id,
                  content: type.label,
                  panelID: `${type.id}-panel`,
                }))}
                selected={RESOURCE_TYPES.findIndex(
                  (t) => t.id === resourceType,
                )}
                onSelect={(index) =>
                  handleResourceTypeChange(RESOURCE_TYPES[index].id)
                }
              />
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* Mappings Table */}
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <InlineStack align="space-between">
                <Text variant="headingMd" as="h2">
                  {RESOURCE_TYPES.find((t) => t.id === resourceType)?.label ||
                    "Mappings"}
                </Text>
                <Text variant="bodyMd" color="subdued">
                  {totalMappings} total mapping{totalMappings !== 1 ? "s" : ""}
                </Text>
              </InlineStack>

              {/* Search */}
              <TextField
                label="Search"
                value={searchQuery}
                onChange={setSearchQuery}
                placeholder="Search by ID, match key, match value, title, or sync ID..."
                prefix={<SearchIcon />}
                clearButton
                onClearButtonClick={() => setSearchQuery("")}
                autoComplete="off"
              />

              {filteredMappings.length === 0 ? (
                <EmptyState
                  heading={`No ${RESOURCE_TYPES.find((t) => t.id === resourceType)?.label?.toLowerCase()} mappings found`}
                  image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
                >
                  <p>
                    {searchQuery
                      ? "Try adjusting your search query."
                      : "Run a sync operation to create mappings between production and staging resources."}
                  </p>
                </EmptyState>
              ) : (
                <>
                  <DataTable
                    columnContentTypes={[
                      "text",
                      "text",
                      "text",
                      "text",
                      "text",
                      "text",
                      "text",
                    ]}
                    headings={[
                      "Production ID",
                      "Staging ID",
                      "Match Key",
                      "Match Value",
                      "Title",
                      "Sync ID",
                      "Last Synced",
                    ]}
                    rows={tableRows}
                  />

                  {/* Pagination */}
                  {totalPages > 1 && (
                    <InlineStack align="center" gap="200">
                      <Button
                        disabled={page <= 1}
                        onClick={() => handlePageChange(page - 1)}
                      >
                        Previous
                      </Button>
                      <Text variant="bodyMd">
                        Page {page} of {totalPages}
                      </Text>
                      <Button
                        disabled={page >= totalPages}
                        onClick={() => handlePageChange(page + 1)}
                      >
                        Next
                      </Button>
                    </InlineStack>
                  )}
                </>
              )}
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* Connection Info */}
        <Layout.Section>
          <Card>
            <BlockStack gap="200">
              <Text variant="headingMd" as="h2">
                Connection Details
              </Text>
              <Text variant="bodyMd">
                <strong>Source:</strong> {connections[0].name} (
                {connections[0].storeDomain})
              </Text>
              <Text variant="bodySm" color="subdued">
                Mappings track the relationship between production and staging
                resource IDs using their matching keys (handle, name, filename,
                etc.), enabling proper translation of metafield references
                containing GIDs.
              </Text>
              <BlockStack gap="100">
                <Text variant="bodyMd" fontWeight="semibold">
                  Matching Strategy:
                </Text>
                <Text variant="bodySm" color="subdued">
                  • Products, Collections, Pages, Markets, Navigation: Matched
                  by <strong>handle</strong>
                </Text>
                <Text variant="bodySm" color="subdued">
                  • Locations: Matched by <strong>name</strong>{" "}
                  (case-insensitive)
                </Text>
                <Text variant="bodySm" color="subdued">
                  • Files: Matched by <strong>filename</strong> (extracted from
                  URL)
                </Text>
                <Text variant="bodySm" color="subdued">
                  • Metaobjects: Matched by <strong>type</strong>
                </Text>
                <Text variant="bodySm" color="subdued">
                  • Product Variants: Matched by{" "}
                  <strong>selectedOptions</strong> combination
                </Text>
              </BlockStack>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
