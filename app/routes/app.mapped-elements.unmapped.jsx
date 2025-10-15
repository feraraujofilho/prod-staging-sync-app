import { useLoaderData, useNavigate } from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  BlockStack,
  Text,
  DataTable,
  EmptyState,
  Badge,
  InlineStack,
  Button,
  Select,
  Banner,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import {
  getUnmappedReferences,
  getUnmappedReferencesCount,
} from "../services/resource-mapping.server";

// Loader to fetch unmapped references
export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  
  const resourceType = url.searchParams.get("type") || "all";
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
      unmappedReferences: [],
      totalUnmapped: 0,
      resourceType,
      page,
      totalPages: 0,
      groupedByType: {},
    };
  }

  const connectionId = connections[0].id;

  // Get unmapped references
  const options = {
    resolved: false,
    limit,
    offset,
  };

  if (resourceType && resourceType !== "all") {
    options.resourceType = resourceType;
  }

  const unmappedReferences = await getUnmappedReferences(connectionId, options);

  // Get total count
  const countOptions = { resolved: false };
  if (resourceType && resourceType !== "all") {
    countOptions.resourceType = resourceType;
  }
  const totalUnmapped = await getUnmappedReferencesCount(connectionId, countOptions);
  const totalPages = Math.ceil(totalUnmapped / limit);

  // Group by resource type for overview
  const allUnmapped = await getUnmappedReferences(connectionId, {
    resolved: false,
    limit: 1000,
  });
  const groupedByType = allUnmapped.reduce((acc, ref) => {
    acc[ref.resourceType] = (acc[ref.resourceType] || 0) + 1;
    return acc;
  }, {});

  return {
    connections,
    connectionId,
    unmappedReferences,
    totalUnmapped,
    resourceType,
    page,
    totalPages,
    groupedByType,
  };
};

export default function UnmappedReferences() {
  const {
    connections,
    unmappedReferences,
    totalUnmapped,
    resourceType,
    page,
    totalPages,
    groupedByType,
  } = useLoaderData();

  const navigate = useNavigate();

  const handleResourceTypeChange = (newType) => {
    navigate(`/app/mapped-elements/unmapped?type=${newType}&page=1`);
  };

  const handlePageChange = (newPage) => {
    navigate(`/app/mapped-elements/unmapped?type=${resourceType}&page=${newPage}`);
  };

  // Prepare resource type options
  const resourceTypeOptions = [
    { label: "All Types", value: "all" },
    ...Object.keys(groupedByType).map((type) => ({
      label: `${type} (${groupedByType[type]})`,
      value: type,
    })),
  ];

  // Prepare data table rows
  const tableRows = unmappedReferences.map((ref) => [
    <Badge key={`type-${ref.id}`} tone="info">
      {ref.resourceType}
    </Badge>,
    <Text key={`gid-${ref.id}`} variant="bodySm" fontFamily="mono">
      {ref.productionGid}
    </Text>,
    <Text key={`id-${ref.id}`} variant="bodyMd" fontWeight="semibold">
      {ref.productionId}
    </Text>,
    <Text
      key={`context-${ref.id}`}
      variant="bodySm"
      color="subdued"
      breakWord
    >
      {ref.context}
    </Text>,
    <Badge key={`sync-${ref.id}`}>{ref.foundInSyncType}</Badge>,
    <Text key={`date-${ref.id}`} variant="bodySm">
      {new Date(ref.attemptedAt).toLocaleString()}
    </Text>,
  ]);

  if (connections.length === 0) {
    return (
      <Page
        title="Unmapped References"
        backAction={{ content: "Back", url: "/app/mapped-elements" }}
      >
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
              <p>Connect to external Shopify stores to start tracking mappings.</p>
            </EmptyState>
          </Layout.Section>
        </Layout>
      </Page>
    );
  }

  return (
    <Page
      title="Unmapped References"
      subtitle="GID references that could not be mapped during sync"
      backAction={{ content: "Back", url: "/app/mapped-elements" }}
    >
      <Layout>
        {/* Overview Banner */}
        {totalUnmapped > 0 ? (
          <Layout.Section>
            <Banner title="About Unmapped References" status="info">
              <BlockStack gap="200">
                <Text variant="bodyMd">
                  Unmapped references occur when a metafield contains a GID
                  (Shopify Global ID) that points to a resource that hasn't been
                  synced to staging yet.
                </Text>
                <Text variant="bodyMd">
                  <strong>To resolve:</strong> Sync the missing resources first,
                  then re-sync the resources that contain these references.
                </Text>
              </BlockStack>
            </Banner>
          </Layout.Section>
        ) : null}

        {/* Resource Type Filter */}
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <InlineStack align="space-between">
                <Text variant="headingMd" as="h2">
                  Filter by Resource Type
                </Text>
                <Text variant="bodyMd" color="subdued">
                  {totalUnmapped} total unmapped reference
                  {totalUnmapped !== 1 ? "s" : ""}
                </Text>
              </InlineStack>
              <Select
                label="Resource Type"
                options={resourceTypeOptions}
                value={resourceType}
                onChange={handleResourceTypeChange}
              />
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* Unmapped References Table */}
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text variant="headingMd" as="h2">
                Unmapped References
              </Text>

              {unmappedReferences.length === 0 ? (
                <EmptyState
                  heading="No unmapped references"
                  image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
                >
                  <p>
                    All resource references have been successfully mapped! Your
                    metafield values should work correctly in the staging
                    environment.
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
                    ]}
                    headings={[
                      "Type",
                      "Production GID",
                      "Production ID",
                      "Found In",
                      "Sync Type",
                      "Attempted At",
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

        {/* Help Card */}
        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text variant="headingMd" as="h2">
                How to Resolve Unmapped References
              </Text>
              <BlockStack gap="200">
                <Text variant="bodyMd" fontWeight="semibold">
                  1. Identify Missing Resources
                </Text>
                <Text variant="bodyMd" color="subdued">
                  Look at the "Type" and "Production ID" columns to see which
                  resources are missing from staging.
                </Text>

                <Text variant="bodyMd" fontWeight="semibold">
                  2. Sync Missing Resources
                </Text>
                <Text variant="bodyMd" color="subdued">
                  Go to the Data Sync page and sync the missing resource types.
                  For example, if you see unmapped Product references, run the
                  Products sync.
                </Text>

                <Text variant="bodyMd" fontWeight="semibold">
                  3. Re-sync Dependent Resources
                </Text>
                <Text variant="bodyMd" color="subdued">
                  After syncing the missing resources, re-sync the resources that
                  contain these references. Check the "Found In" column to see
                  which resources need to be re-synced.
                </Text>
              </BlockStack>

              <Button url="/app/sync">Go to Data Sync</Button>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}

