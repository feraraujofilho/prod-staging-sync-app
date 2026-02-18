import {
  Page,
  Layout,
  Text,
  Card,
  Button,
  BlockStack,
  List,
  Link,
  InlineStack,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }) => {
  await authenticate.admin(request);

  return null;
};

// Action removed - no longer needed for the sync tool
// If you need to add actions in the future, uncomment and modify this:
// export const action = async ({ request }) => {
//   const { admin } = await authenticate.admin(request);
//   // Your action logic here
// };

export default function Index() {
  return (
    <Page>
      <TitleBar title="StageSync" />
      <BlockStack gap="500">
        <Layout>
          <Layout.Section>
            <Card>
              <BlockStack gap="500">
                <BlockStack gap="200">
                  <Text as="h2" variant="headingMd">
                    Welcome to StageSync
                  </Text>
                  <Text variant="bodyMd" as="p">
                    This app helps you synchronize data between your production
                    and staging Shopify stores. Keep your development
                    environment up-to-date with real production data for better
                    testing and development.
                  </Text>
                </BlockStack>

                <BlockStack gap="200">
                  <Text as="h3" variant="headingMd">
                    Quick Start Guide
                  </Text>

                  <Card>
                    <BlockStack gap="200">
                      <Text as="h4" variant="headingSm">
                        1. Set up your source store connection
                      </Text>
                      <Text as="p" variant="bodyMd">
                        Go to{" "}
                        <Link url="/app/settings" removeUnderline>
                          Settings
                        </Link>{" "}
                        and add your production store connection using the
                        access token from your custom app.
                      </Text>
                    </BlockStack>
                  </Card>

                  <Card>
                    <BlockStack gap="200">
                      <Text as="h4" variant="headingSm">
                        2. Choose what to sync
                      </Text>
                      <Text as="p" variant="bodyMd">
                        Navigate to{" "}
                        <Link url="/app/sync" removeUnderline>
                          Data Sync
                        </Link>{" "}
                        to select which types of data you want to synchronize.
                      </Text>
                    </BlockStack>
                  </Card>

                  <Card>
                    <BlockStack gap="200">
                      <Text as="h4" variant="headingSm">
                        3. Run the sync
                      </Text>
                      <Text as="p" variant="bodyMd">
                        Click the sync button for each data type you want to
                        transfer. Monitor progress and check logs for any
                        issues.
                      </Text>
                    </BlockStack>
                  </Card>
                </BlockStack>

                <InlineStack gap="300">
                  <Button url="/app/settings" primary>
                    Configure Settings
                  </Button>
                  <Button url="/app/sync">Start Syncing</Button>
                </InlineStack>
              </BlockStack>
            </Card>
          </Layout.Section>

          <Layout.Section variant="oneThird">
            <BlockStack gap="500">
              <Card>
                <BlockStack gap="200">
                  <Text as="h2" variant="headingMd">
                    Sync Capabilities
                  </Text>
                  <List>
                    <List.Item>
                      <strong>Products</strong> - Complete catalog with
                      variants, images, and metafields
                    </List.Item>
                    <List.Item>
                      <strong>Collections</strong> - Smart and manual
                      collections with rules
                    </List.Item>
                    <List.Item>
                      <strong>Navigation</strong> - Online store menus
                    </List.Item>
                    <List.Item>
                      <strong>Pages</strong> - Static content pages
                    </List.Item>
                    <List.Item>
                      <strong>Markets</strong> - International configurations
                    </List.Item>
                    <List.Item>
                      <strong>Locations</strong> - Store locations
                    </List.Item>
                    <List.Item>
                      <strong>Metafields</strong> - Custom field definitions and
                      values
                    </List.Item>
                    <List.Item>
                      <strong>Theme Images</strong> - Assets from theme editor
                    </List.Item>
                  </List>
                </BlockStack>
              </Card>

              <Card>
                <BlockStack gap="200">
                  <Text as="h2" variant="headingMd">
                    Important Notes
                  </Text>
                  <BlockStack gap="200">
                    <Text as="p" variant="bodyMd">
                      • Data flows one-way: production → staging
                    </Text>
                    <Text as="p" variant="bodyMd">
                      • Always backup your staging data first
                    </Text>
                    <Text as="p" variant="bodyMd">
                      • Some IDs and references may need manual adjustment
                    </Text>
                    <Text as="p" variant="bodyMd">
                      • Review sync logs for any warnings or errors
                    </Text>
                  </BlockStack>
                </BlockStack>
              </Card>
            </BlockStack>
          </Layout.Section>
        </Layout>
      </BlockStack>
    </Page>
  );
}
