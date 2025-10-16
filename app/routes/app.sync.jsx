import { useState, useCallback, useEffect, useRef } from "react";
import {
  useLoaderData,
  useActionData,
  useNavigation,
  useSubmit,
  useFetcher,
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
  DataTable,
  Scrollable,
  Icon,
  Box,
  Modal,
  ProgressBar,
  Checkbox,
} from "@shopify/polaris";
import {
  RefreshIcon,
  ProductIcon,
  CollectionIcon,
  ProfileIcon,
  SettingsIcon,
  ImportIcon,
  ImageIcon,
} from "@shopify/polaris-icons";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { syncMetafieldDefinitions } from "../services/sync.metafields.server";
import { syncMetaobjectDefinitions } from "../services/sync.metaobjects.server";
import { syncImageFiles } from "../services/sync.files.server";
import { syncNavigationMenus } from "../services/sync.navigation.server";
import { syncPages } from "../services/sync.pages.server";
import { syncMarkets } from "../services/sync.markets.server";
import { syncProducts } from "../services/sync.products.server";
import { syncCollections } from "../services/sync.collections.server";
import { syncLocations } from "../services/sync.locations.server";
import { syncSearchDiscoveryMetafields } from "../services/sync.search-discovery.server";

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

  // Fetch currently running syncs so UI can display a banner even after refresh
  const activeLogs = await prisma.syncLog.findMany({
    where: { shop: session.shop, status: "in_progress" },
    orderBy: { startedAt: "desc" },
    take: 5,
    select: {
      id: true,
      syncType: true,
      status: true,
      summary: true,
      startedAt: true,
    },
  });

  // Get the most recently used connection ID for preselection
  const lastUsedConnection = await prisma.syncLog.findFirst({
    where: { shop: session.shop },
    orderBy: { startedAt: "desc" },
    select: {
      connectionId: true,
    },
  });

  return {
    connections,
    recentLogs,
    lastUsedConnectionId: lastUsedConnection?.connectionId || "",
    activeLogs,
  };
};

// Helper function to run sync with timeout
async function runSyncWithTimeout(syncFunction, timeoutMs = 90000) {
  return new Promise((resolve) => {
    let timeoutId;
    let completed = false;

    // Set timeout
    timeoutId = setTimeout(() => {
      if (!completed) {
        completed = true;
        resolve({
          success: false,
          error:
            "Sync operation timed out. The sync may still be running in the background. Please check the sync history for updates.",
          timeout: true,
          summary: {
            total: 0,
            created: 0,
            updated: 0,
            skipped: 0,
            failed: 0,
            errors: [
              "Operation timed out after " + timeoutMs / 1000 + " seconds",
            ],
          },
        });
      }
    }, timeoutMs);

    // Run the sync function
    syncFunction()
      .then((result) => {
        if (!completed) {
          completed = true;
          clearTimeout(timeoutId);
          resolve(result);
        }
      })
      .catch((error) => {
        if (!completed) {
          completed = true;
          clearTimeout(timeoutId);
          resolve({
            success: false,
            error: error.message,
            summary: {
              total: 0,
              created: 0,
              updated: 0,
              skipped: 0,
              failed: 0,
              errors: [error.message],
            },
          });
        }
      });
  });
}

// Action handler for sync operations
export const action = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();

  const syncType = formData.get("syncType");
  const connectionId = formData.get("connectionId");

  if (!connectionId) {
    return { error: "Please select a connection" };
  }

  // Fetch connection with token
  const connection = await prisma.storeConnection.findUnique({
    where: { id: connectionId },
  });

  if (!connection || connection.shop !== session.shop) {
    return { error: "Invalid connection" };
  }

  const { decrypt } = await import("../utils/encryption.server");
  const decryptedToken = decrypt(connection.encryptedToken);
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
        // Sync all metafield definitions EXCEPT product and variant (those are handled in product sync)
        const metafieldTypes = [
          "COLLECTION",
          "CUSTOMER",
          "ORDER",
          "DRAFTORDER",
          "PAGE",
          "SHOP",
          "ARTICLE",
          "BLOG",
          "COMPANY",
          "COMPANYLOCATION",
          "LOCATION",
          "MARKET",
        ];
        result = await runSyncWithTimeout(() =>
          syncMetafieldDefinitions(
            connection.storeDomain,
            decryptedToken,
            admin,
            metafieldTypes,
          ),
        );
        break;

      case "metaobject_definitions":
        result = await runSyncWithTimeout(() =>
          syncMetaobjectDefinitions(
            connection.storeDomain,
            decryptedToken,
            admin,
            connection.id,
          ),
        );
        break;

      case "products": {
        // Kick off a background sync and return immediately with the log id
        // so the UI can poll progress. This avoids Cloudflare 524 timeouts.
        (async () => {
          try {
            const onProgress = async (progress) => {
              try {
                // Persist progress stage/percentage so UI can show a live bar
                await prisma.syncLog.update({
                  where: { id: syncLog.id },
                  data: {
                    summary: JSON.stringify({
                      progress: {
                        percentage: progress.percentage ?? 0,
                        stage: progress.stage ?? "running",
                        message: progress.message ?? "",
                      },
                    }),
                  },
                });
              } catch (e) {
                console.error("Failed to update sync progress:", e);
              }
            };

            const bgResult = await syncProducts(
              connection.storeDomain,
              decryptedToken,
              admin,
              connection.id,
              onProgress,
            );

            const hasErrors =
              bgResult.summary?.errors && bgResult.summary.errors.length > 0;
            const hasSuccess =
              bgResult.summary?.created > 0 || bgResult.summary?.updated > 0;

            let status = "failed";
            if (hasSuccess && hasErrors) {
              status = "partially_successful";
            } else if (
              hasSuccess ||
              (!hasErrors &&
                (bgResult.summary?.total > 0 || bgResult.summary?.skipped > 0))
            ) {
              status = "success";
            }

            const logsToSave = bgResult.logs || bgResult.log || [];

            await prisma.syncLog.update({
              where: { id: syncLog.id },
              data: {
                status,
                summary: JSON.stringify(bgResult.summary || {}),
                logs: JSON.stringify(logsToSave),
                completedAt: new Date(),
              },
            });
          } catch (err) {
            await prisma.syncLog.update({
              where: { id: syncLog.id },
              data: {
                status: "failed",
                summary: JSON.stringify({ error: err.message }),
                completedAt: new Date(),
              },
            });
          }
        })();

        // Return quickly; UI will poll /app/sync/status?logId=...
        return {
          started: true,
          logId: syncLog.id,
          message:
            "Product sync started and is running in the background. You can close this window.",
        };
      }

      case "collections": {
        // Run collections sync in background to avoid timeouts
        (async () => {
          try {
            const onProgress = async (progress) => {
              try {
                await prisma.syncLog.update({
                  where: { id: syncLog.id },
                  data: {
                    summary: JSON.stringify({
                      progress: {
                        percentage: progress.percentage ?? 0,
                        stage: progress.stage ?? "running",
                        message: progress.message ?? "",
                      },
                    }),
                  },
                });
              } catch (e) {
                console.error("Failed to update sync progress:", e);
              }
            };

            const bgResult = await syncCollections(
              connection.storeDomain,
              decryptedToken,
              admin,
              connection.id,
              onProgress,
            );

            const hasErrors =
              bgResult.summary?.errors && bgResult.summary.errors.length > 0;
            const hasSuccess =
              bgResult.summary?.created > 0 || bgResult.summary?.updated > 0;

            let status = "failed";
            if (hasSuccess && hasErrors) {
              status = "partially_successful";
            } else if (
              hasSuccess ||
              (!hasErrors &&
                (bgResult.summary?.total > 0 || bgResult.summary?.skipped > 0))
            ) {
              status = "success";
            }

            const logsToSave = bgResult.logs || bgResult.log || [];

            await prisma.syncLog.update({
              where: { id: syncLog.id },
              data: {
                status,
                summary: JSON.stringify(bgResult.summary || {}),
                logs: JSON.stringify(logsToSave),
                completedAt: new Date(),
              },
            });
          } catch (err) {
            await prisma.syncLog.update({
              where: { id: syncLog.id },
              data: {
                status: "failed",
                summary: JSON.stringify({ error: err.message }),
                completedAt: new Date(),
              },
            });
          }
        })();

        return {
          started: true,
          logId: syncLog.id,
          message:
            "Collections sync started and is running in the background. You can close this window.",
        };
      }

      case "files": {
        // Run files sync in background to avoid timeouts with high volume
        (async () => {
          try {
            const onProgress = async (progress) => {
              try {
                await prisma.syncLog.update({
                  where: { id: syncLog.id },
                  data: {
                    summary: JSON.stringify({
                      progress: {
                        percentage: progress.percentage ?? 0,
                        stage: progress.stage ?? "running",
                        message: progress.message ?? "",
                      },
                    }),
                  },
                });
              } catch (e) {
                console.error("Failed to update sync progress:", e);
              }
            };

            const bgResult = await syncImageFiles(
              connection.storeDomain,
              decryptedToken,
              admin,
              connection.id,
              onProgress,
            );

            const hasErrors =
              bgResult.summary?.errors && bgResult.summary.errors.length > 0;
            const hasSuccess = bgResult.summary?.created > 0;

            let status = "failed";
            if (hasSuccess && hasErrors) {
              status = "partially_successful";
            } else if (
              hasSuccess ||
              (!hasErrors &&
                (bgResult.summary?.total > 0 || bgResult.summary?.skipped > 0))
            ) {
              status = "success";
            }

            const logsToSave = bgResult.logs || bgResult.log || [];

            await prisma.syncLog.update({
              where: { id: syncLog.id },
              data: {
                status,
                summary: JSON.stringify(bgResult.summary || {}),
                logs: JSON.stringify(logsToSave),
                completedAt: new Date(),
              },
            });
          } catch (err) {
            await prisma.syncLog.update({
              where: { id: syncLog.id },
              data: {
                status: "failed",
                summary: JSON.stringify({ error: err.message }),
                completedAt: new Date(),
              },
            });
          }
        })();

        return {
          started: true,
          logId: syncLog.id,
          message:
            "Files sync started and is running in the background. You can close this window.",
        };
      }

      case "navigation":
        result = await runSyncWithTimeout(() =>
          syncNavigationMenus(
            connection.storeDomain,
            decryptedToken,
            admin,
            connection.id,
          ),
        );
        break;

      case "pages":
        result = await runSyncWithTimeout(() =>
          syncPages(
            connection.storeDomain,
            decryptedToken,
            admin,
            connection.id,
          ),
        );
        break;

      case "markets":
        result = await runSyncWithTimeout(() =>
          syncMarkets(
            connection.storeDomain,
            decryptedToken,
            admin,
            connection.id,
          ),
        );
        break;

      case "locations":
        result = await runSyncWithTimeout(() =>
          syncLocations(
            connection.storeDomain,
            decryptedToken,
            admin,
            connection.id,
            (progress) => {
              // Progress callback for locations sync
              console.log("Location sync progress:", progress);
            },
          ),
        );
        break;

      case "search_discovery": {
        // Run search & discovery sync in background to avoid timeouts
        (async () => {
          try {
            const onProgress = async (progress) => {
              try {
                await prisma.syncLog.update({
                  where: { id: syncLog.id },
                  data: {
                    summary: JSON.stringify({
                      progress: {
                        percentage: progress.percentage ?? 0,
                        stage: progress.stage ?? "running",
                        message: progress.message ?? "",
                      },
                    }),
                  },
                });
              } catch (e) {
                console.error("Failed to update sync progress:", e);
              }
            };

            const bgResult = await syncSearchDiscoveryMetafields(
              connection.storeDomain,
              decryptedToken,
              admin,
              connection.id,
              onProgress,
            );

            const hasErrors =
              bgResult.summary?.errors && bgResult.summary.errors.length > 0;
            const hasSuccess = bgResult.summary?.updated > 0;

            let status = "failed";
            if (hasSuccess && hasErrors) {
              status = "partially_successful";
            } else if (
              hasSuccess ||
              (!hasErrors &&
                (bgResult.summary?.total > 0 || bgResult.summary?.skipped > 0))
            ) {
              status = "success";
            }

            const logsToSave = bgResult.logs || bgResult.log || [];

            await prisma.syncLog.update({
              where: { id: syncLog.id },
              data: {
                status,
                summary: JSON.stringify(bgResult.summary || {}),
                logs: JSON.stringify(logsToSave),
                completedAt: new Date(),
              },
            });
          } catch (err) {
            await prisma.syncLog.update({
              where: { id: syncLog.id },
              data: {
                status: "failed",
                summary: JSON.stringify({ error: err.message }),
                completedAt: new Date(),
              },
            });
          }
        })();

        return {
          started: true,
          logId: syncLog.id,
          message:
            "Search & Discovery sync started and is running in the background. You can close this window.",
        };
      }

      default:
        result = {
          success: false,
          error: "Invalid sync type",
        };
    }

    // Determine success based on summary data
    const hasErrors =
      result.summary?.errors && result.summary.errors.length > 0;
    const hasSuccess =
      result.summary?.created > 0 || result.summary?.updated > 0;

    // Determine status: success, partially successful, or failed
    let status = "failed";
    if (hasSuccess && hasErrors) {
      status = "partially_successful";
    } else if (
      hasSuccess ||
      (!hasErrors && (result.summary?.total > 0 || result.summary?.skipped > 0))
    ) {
      status = "success";
    }

    // Debug: Log what we're about to save
    const logsToSave = result.logs || result.log || [];
    console.log("=== SYNC DEBUG ===");
    console.log("Sync type:", syncType);
    console.log("Result summary:", JSON.stringify(result.summary, null, 2));
    console.log("Result logs count:", logsToSave.length);
    console.log(
      "First few logs:",
      JSON.stringify(logsToSave.slice(0, 3), null, 2),
    );
    console.log("==================");

    // Update sync log with results
    await prisma.syncLog.update({
      where: { id: syncLog.id },
      data: {
        status: status,
        summary: JSON.stringify(result.summary || {}),
        logs: JSON.stringify(logsToSave),
        completedAt: new Date(),
      },
    });

    return {
      ...result,
      success: status === "success" || status === "partially_successful",
    };
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
    id: "metaobject_definitions",
    label: "Metaobject Definitions",
    description: "Sync metaobject definitions between stores",
    icon: ImportIcon,
    available: true,
  },
  {
    id: "locations",
    label: "Locations",
    description: "Sync store locations for inventory management",
    icon: ImportIcon,
    available: true,
  },
  {
    id: "files",
    label: "Theme Images",
    description:
      "Sync images uploaded in theme editor (excludes product images)",
    icon: ImageIcon,
    available: true,
  },
  {
    id: "navigation",
    label: "Navigation Menus",
    description: "Sync navigation menus and their structure",
    icon: SettingsIcon,
    available: true,
  },
  {
    id: "pages",
    label: "Pages",
    description: "Sync online store pages and their content",
    icon: ProfileIcon,
    available: true,
  },
  {
    id: "markets",
    label: "Markets",
    description: "Sync Shopify Markets configuration and settings",
    icon: SettingsIcon,
    available: true,
  },
  {
    id: "products",
    label: "Products",
    description:
      "Sync product catalog including variants, images, and metafields",
    icon: ProductIcon,
    available: true,
    // cliRecommended: true,
  },
  /* {
    id: "metafield_definitions",
    label: "Metafield Definitions",
    description:
      "Sync metafield structures between stores (excludes product/variant metafields - use Product sync for those)",
    icon: SettingsIcon,
    available: false,
  }, */
  {
    id: "collections",
    label: "Collections",
    description:
      "Sync collections and their product associations (run the product sync previously)",
    icon: CollectionIcon,
    available: true,
  },
  {
    id: "search_discovery",
    label: "Search & Discovery Settings",
    description:
      "Translate product references in Search & Discovery app metafields (complementary/related products)",
    icon: SettingsIcon,
    available: true,
  },
];

export default function DataSync() {
  const { connections, recentLogs, lastUsedConnectionId, activeLogs } =
    useLoaderData();
  const actionData = useActionData();
  const navigation = useNavigation();
  const submit = useSubmit();
  const statusFetcher = useFetcher();

  const [selectedTab, setSelectedTab] = useState(0);
  const [selectedConnection, setSelectedConnection] =
    useState(lastUsedConnectionId);
  const [showLogs, setShowLogs] = useState(false);
  const [selectedLogId, setSelectedLogId] = useState(null);
  const [selectedLogDetails, setSelectedLogDetails] = useState(null);
  const [selectedSyncTypes, setSelectedSyncTypes] = useState([]);
  const [currentSyncIndex, setCurrentSyncIndex] = useState(0);
  const [syncProgress, setSyncProgress] = useState(null);
  const [isRunningBulkSync, setIsRunningBulkSync] = useState(false);
  const [activeLogId, setActiveLogId] = useState(null);
  const [backgroundStatus, setBackgroundStatus] = useState(null);

  const isLoading = navigation.state === "submitting";

  // Track previous navigation state for better sync detection
  const prevNavigationStateRef = useRef(navigation.state);

  // Auto-show logs when sync completes
  useEffect(() => {
    if (actionData?.logs && actionData?.success !== undefined) {
      setShowLogs(true);
    }
  }, [actionData]);

  // When a background job is started by the action, begin polling status
  useEffect(() => {
    if (actionData?.started && actionData?.logId) {
      setActiveLogId(actionData.logId);
      setBackgroundStatus({ status: "in_progress" });
      // kick off an immediate load
      statusFetcher.load(`/app/sync/status?logId=${actionData.logId}`);
    }
  }, [actionData, statusFetcher]);

  // On initial page load, if there is an active sync from the loader, start polling it
  useEffect(() => {
    if (!activeLogId && Array.isArray(activeLogs) && activeLogs.length > 0) {
      const log = activeLogs[0];
      let initialSummary = null;
      try {
        initialSummary = log.summary ? JSON.parse(log.summary) : null;
      } catch {
        initialSummary = { message: log.summary };
      }
      setActiveLogId(log.id);
      setBackgroundStatus({
        status: log.status,
        summary: initialSummary,
        startedAt: log.startedAt,
      });
      statusFetcher.load(`/app/sync/status?logId=${log.id}`);
    }
  }, [activeLogs, activeLogId, statusFetcher]);

  // Poll every 3s while activeLogId is set and until completed
  useEffect(() => {
    if (!activeLogId) return;
    const interval = setInterval(() => {
      statusFetcher.load(`/app/sync/status?logId=${activeLogId}`);
    }, 3000);
    return () => clearInterval(interval);
  }, [activeLogId, statusFetcher]);

  // Track fetcher data for background progress/completion
  useEffect(() => {
    if (statusFetcher.data) {
      setBackgroundStatus(statusFetcher.data);
      if (statusFetcher.data.completedAt) {
        // Show logs when job completes via polling
        setShowLogs(true);
      }
    }
  }, [statusFetcher.data]);

  // Handle bulk sync progress
  useEffect(() => {
    const prevState = prevNavigationStateRef.current;
    const currentState = navigation.state;

    console.log("Bulk sync state check:", {
      isRunningBulkSync,
      prevNavigationState: prevState,
      currentNavigationState: currentState,
      currentSyncIndex,
      totalSyncs: selectedSyncTypes.length,
      hasActionData: !!actionData,
    });

    // Detect when a sync has just completed (transition from submitting/loading to idle)
    const justCompleted =
      prevState !== "idle" && currentState === "idle" && isRunningBulkSync;

    // Update previous state ref
    prevNavigationStateRef.current = currentState;

    if (justCompleted) {
      console.log(
        `Sync completed. Current index: ${currentSyncIndex}, Total: ${selectedSyncTypes.length}`,
      );

      // Check if we have more syncs to run
      if (currentSyncIndex < selectedSyncTypes.length - 1) {
        // Move to next sync
        const nextIndex = currentSyncIndex + 1;
        const nextSyncType = selectedSyncTypes[nextIndex];

        console.log(
          `Moving to next sync: ${nextSyncType} (${nextIndex + 1}/${selectedSyncTypes.length})`,
        );

        // Update state for next sync
        setCurrentSyncIndex(nextIndex);
        setSyncProgress({
          current: nextIndex,
          total: selectedSyncTypes.length,
          currentSync: nextSyncType,
          percentage: Math.round((nextIndex / selectedSyncTypes.length) * 100),
        });

        // Submit next sync with a small delay to ensure state updates
        setTimeout(() => {
          console.log(`Submitting next sync: ${nextSyncType}`);
          const formData = new FormData();
          formData.append("syncType", nextSyncType);
          formData.append("connectionId", selectedConnection);
          formData.append("isBulkSync", "true");
          submit(formData, { method: "post" });
        }, 1000); // Increased delay for more reliable execution
      } else {
        // All syncs complete
        console.log("All bulk syncs complete!");
        setSyncProgress({
          current: selectedSyncTypes.length,
          total: selectedSyncTypes.length,
          currentSync: selectedSyncTypes[selectedSyncTypes.length - 1],
          percentage: 100,
          complete: true,
        });

        // Clear state after showing completion
        setTimeout(() => {
          setIsRunningBulkSync(false);
          setSyncProgress(null);
          setCurrentSyncIndex(0);
          setSelectedSyncTypes([]);
        }, 3000);
      }
    }
  }, [
    navigation.state,
    isRunningBulkSync,
    currentSyncIndex,
    selectedSyncTypes,
    selectedConnection,
    submit,
    actionData,
  ]);

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

  const handleSyncTypeToggle = useCallback((syncTypeId) => {
    setSelectedSyncTypes((prev) => {
      if (prev.includes(syncTypeId)) {
        return prev.filter((id) => id !== syncTypeId);
      } else {
        return [...prev, syncTypeId];
      }
    });
  }, []);

  const handleSelectAll = useCallback(() => {
    const availableSyncTypes = SYNC_TYPES.filter((type) => type.available).map(
      (type) => type.id,
    );
    setSelectedSyncTypes(availableSyncTypes);
  }, []);

  const handleDeselectAll = useCallback(() => {
    setSelectedSyncTypes([]);
  }, []);

  const handleBulkSync = useCallback(() => {
    if (!selectedConnection || selectedSyncTypes.length === 0) {
      return;
    }

    console.log(
      `Starting bulk sync with ${selectedSyncTypes.length} types:`,
      selectedSyncTypes,
    );

    setIsRunningBulkSync(true);
    setCurrentSyncIndex(0);
    setSyncProgress({
      current: 0,
      total: selectedSyncTypes.length,
      currentSync: selectedSyncTypes[0],
      percentage: 0,
    });

    // Start first sync
    console.log(`Starting first sync: ${selectedSyncTypes[0]}`);
    const formData = new FormData();
    formData.append("syncType", selectedSyncTypes[0]);
    formData.append("connectionId", selectedConnection);
    formData.append("isBulkSync", "true");
    submit(formData, { method: "post" });
  }, [selectedConnection, selectedSyncTypes, submit]);

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
        {/* Background running banner/progress (products) */}
        {activeLogId && backgroundStatus?.status === "in_progress" && (
          <Layout.Section>
            <Banner status="info" title="Sync is running in the background">
              <BlockStack gap="200">
                <Text variant="bodyMd">
                  You can safely close this window; the sync continues in the
                  background. Check the Sync History tab for updates.
                </Text>
                <ProgressBar
                  progress={
                    backgroundStatus?.summary?.progress?.percentage ??
                    backgroundStatus?.summary?.percentage ??
                    0
                  }
                  size="small"
                />
                {backgroundStatus?.summary?.progress?.message && (
                  <Text variant="bodySm" color="subdued">
                    {backgroundStatus.summary.progress.message}
                  </Text>
                )}
                {backgroundStatus?.summary?.progress?.stage && (
                  <Text variant="bodySm" color="subdued">
                    Stage: {backgroundStatus.summary.progress.stage}
                  </Text>
                )}
              </BlockStack>
            </Banner>
          </Layout.Section>
        )}
        {actionData?.error && (
          <Layout.Section>
            <Banner
              status={actionData.timeout ? "warning" : "critical"}
              title={
                actionData.timeout ? "Sync operation timed out" : "Sync error"
              }
            >
              <BlockStack gap="200">
                <Text variant="bodyMd">{actionData.error}</Text>
                {actionData.timeout && (
                  <Text variant="bodyMd" color="subdued">
                    Large sync operations may take more time than the browser
                    allows. The sync might still be running in the background.
                    Please refresh the page and check the sync history for
                    updates.
                  </Text>
                )}
              </BlockStack>
            </Banner>
          </Layout.Section>
        )}

        {actionData?.success && (
          <Layout.Section>
            <Banner
              status={(() => {
                try {
                  const summaryData =
                    typeof actionData.summary === "string"
                      ? JSON.parse(actionData.summary)
                      : actionData.summary;
                  return summaryData?.errors?.length > 0
                    ? "warning"
                    : "success";
                } catch {
                  return "success";
                }
              })()}
              title={(() => {
                try {
                  const summaryData =
                    typeof actionData.summary === "string"
                      ? JSON.parse(actionData.summary)
                      : actionData.summary;
                  return summaryData?.errors?.length > 0
                    ? "Sync completed with warnings"
                    : "Sync completed successfully";
                } catch {
                  return "Sync completed successfully";
                }
              })()}
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

                      const summaryElements = [];

                      // Add numeric summary values
                      Object.entries(summaryData)
                        .filter(([key]) => relevantKeys.includes(key))
                        .forEach(([key, value]) => {
                          summaryElements.push(
                            <Text key={key} variant="bodyMd">
                              {key
                                .replace(/_/g, " ")
                                .replace(/\b\w/g, (l) => l.toUpperCase())}
                              : {value}
                            </Text>,
                          );
                        });

                      // Handle errors array if present
                      if (
                        summaryData.errors &&
                        Array.isArray(summaryData.errors) &&
                        summaryData.errors.length > 0
                      ) {
                        summaryElements.push(
                          <Box
                            key="errors"
                            padding="200"
                            background="bg-warning-subdued"
                            borderRadius="200"
                          >
                            <BlockStack gap="100">
                              <Text variant="bodyMd" fontWeight="semibold">
                                Errors encountered:
                              </Text>
                              {summaryData.errors
                                .slice(0, 5)
                                .map((error, index) => (
                                  <Text
                                    key={`error-${index}`}
                                    variant="bodySm"
                                    color="warning"
                                  >
                                    • {error}
                                  </Text>
                                ))}
                              {summaryData.errors.length > 5 && (
                                <Text variant="bodySm" color="subdued">
                                  ... and {summaryData.errors.length - 5} more
                                  errors
                                </Text>
                              )}
                            </BlockStack>
                          </Box>,
                        );
                      }

                      return summaryElements;
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
                    disabled={isRunningBulkSync}
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
                    <>
                      <Card>
                        <BlockStack gap="400">
                          <InlineStack align="space-between">
                            <Text variant="headingMd" as="h2">
                              Available Sync Operations
                            </Text>
                            <InlineStack gap="200">
                              <Button
                                onClick={handleSelectAll}
                                plain
                                disabled={isRunningBulkSync}
                              >
                                Select All
                              </Button>
                              <Button
                                onClick={handleDeselectAll}
                                plain
                                disabled={isRunningBulkSync}
                              >
                                Deselect All
                              </Button>
                              <Button
                                primary
                                disabled={
                                  selectedSyncTypes.length === 0 ||
                                  !selectedConnection ||
                                  isRunningBulkSync
                                }
                                onClick={handleBulkSync}
                              >
                                Run {selectedSyncTypes.length} Selected Sync
                                {selectedSyncTypes.length !== 1 ? "s" : ""}
                              </Button>
                            </InlineStack>
                          </InlineStack>

                          {!selectedConnection && (
                            <Banner status="warning">
                              Please select a source connection above before
                              running any sync operations.
                            </Banner>
                          )}

                          {/* <Banner
                            status="info"
                            title="Recommended: Shopify CLI Store Copy"
                          >
                            <BlockStack gap="200">
                              <Text variant="bodyMd">
                                For syncing{" "}
                                <strong>
                                  Products, Product Variants with inventory
                                  items, Product Files (Images), Product
                                  Metafields, and Product Metafield Definitions
                                </strong>
                                , we recommend using Shopify's new CLI store
                                copy command.
                              </Text>
                              <Text variant="bodyMd">
                                The CLI provides the best and simplest path for
                                product data synchronization.
                              </Text>
                              <Text variant="bodyMd">
                                <a
                                  href="https://shopify.dev/docs/beta/store-copy"
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  style={{
                                    color: "#0064e0",
                                    fontWeight: "600",
                                    textDecoration: "underline",
                                  }}
                                >
                                  Learn more about the Store Copy command →
                                </a>
                              </Text>
                            </BlockStack>
                          </Banner> */}

                          {/* <Banner
                            status="warning"
                            title="Note about large sync operations"
                          >
                            <Text variant="bodyMd">
                              Large sync operations (especially for Products
                              with many items) may take longer than 90 seconds.
                              If a sync times out, it might still be running in
                              the background. Check the Sync History tab for
                              updates on the operation status.
                            </Text>
                          </Banner> */}

                          {syncProgress && (
                            <Box
                              padding="400"
                              background="bg-surface-secondary"
                              borderRadius="200"
                            >
                              <BlockStack gap="200">
                                <InlineStack align="space-between">
                                  <Text variant="headingSm">
                                    {syncProgress.complete
                                      ? "Bulk Sync Complete!"
                                      : "Bulk Sync Progress"}
                                  </Text>
                                  <Text variant="bodySm" color="subdued">
                                    {syncProgress.current} of{" "}
                                    {syncProgress.total} complete
                                  </Text>
                                </InlineStack>
                                <ProgressBar
                                  progress={syncProgress.percentage}
                                  size="small"
                                  tone={
                                    syncProgress.complete
                                      ? "success"
                                      : "primary"
                                  }
                                />
                                <Text variant="bodySm" color="subdued">
                                  {syncProgress.complete
                                    ? "All selected syncs have been completed successfully!"
                                    : `Currently syncing: ${SYNC_TYPES.find((t) => t.id === syncProgress.currentSync)?.label || syncProgress.currentSync}`}
                                </Text>
                              </BlockStack>
                            </Box>
                          )}

                          <BlockStack gap="300">
                            <Box
                              padding="300"
                              borderRadius="200"
                              background="bg-info-subdued"
                            >
                              <InlineStack gap="300" blockAlign="center">
                                <Icon source={SettingsIcon} color="info" />
                                <Text variant="bodySm" color="subdued">
                                  Configure navigation menu sync settings in{" "}
                                  <a
                                    href="/app/navigation-config"
                                    style={{
                                      color: "inherit",
                                      textDecoration: "underline",
                                    }}
                                  >
                                    Navigation Settings
                                  </a>
                                </Text>
                              </InlineStack>
                            </Box>

                            {SYNC_TYPES.map((syncType) => (
                              <Box
                                key={syncType.id}
                                padding="400"
                                borderRadius="200"
                                background={
                                  !syncType.available
                                    ? "bg-surface-disabled"
                                    : selectedSyncTypes.includes(syncType.id)
                                      ? "bg-surface-selected"
                                      : "bg-surface"
                                }
                              >
                                <InlineStack
                                  gap="400"
                                  align="space-between"
                                  blockAlign="center"
                                >
                                  <InlineStack gap="400" blockAlign="center">
                                    <Checkbox
                                      checked={selectedSyncTypes.includes(
                                        syncType.id,
                                      )}
                                      onChange={() =>
                                        handleSyncTypeToggle(syncType.id)
                                      }
                                      disabled={
                                        !syncType.available || isRunningBulkSync
                                      }
                                    />
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
                                      isLoading ||
                                      isRunningBulkSync
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
                                {syncType.cliRecommended && (
                                  <div style={{ marginTop: "0.75rem" }}>
                                    <Box
                                      padding="300"
                                      borderRadius="100"
                                      background="bg-info-subdued"
                                    >
                                      <InlineStack
                                        gap="200"
                                        blockAlign="center"
                                      >
                                        <Text variant="bodySm" color="info">
                                          💡 <strong>Recommended:</strong> Use{" "}
                                          <a
                                            href="https://shopify.dev/docs/beta/store-copy"
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            style={{
                                              color: "inherit",
                                              textDecoration: "underline",
                                            }}
                                          >
                                            Shopify CLI store copy
                                          </a>{" "}
                                          for the best product sync experience
                                        </Text>
                                      </InlineStack>
                                    </Box>
                                  </div>
                                )}
                              </Box>
                            ))}
                          </BlockStack>
                        </BlockStack>
                      </Card>
                    </>
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
                              "text",
                            ]}
                            headings={[
                              "Type",
                              "Source",
                              "Status",
                              "Summary",
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

                              // Parse summary for display
                              let summaryText = "No data";
                              try {
                                const summary = JSON.parse(log.summary || "{}");
                                if (summary.total !== undefined) {
                                  const parts = [];
                                  if (summary.created > 0)
                                    parts.push(`${summary.created} created`);
                                  if (summary.updated > 0)
                                    parts.push(`${summary.updated} updated`);
                                  if (summary.skipped > 0)
                                    parts.push(`${summary.skipped} skipped`);
                                  if (summary.failed > 0)
                                    parts.push(`${summary.failed} failed`);
                                  summaryText =
                                    parts.length > 0
                                      ? parts.join(", ")
                                      : `${summary.total} total`;
                                }
                              } catch (e) {
                                summaryText = "Error parsing";
                              }

                              return [
                                log.syncType
                                  .replace(/_/g, " ")
                                  .replace(/\b\w/g, (l) => l.toUpperCase()),
                                log.connection.name,
                                <Badge
                                  key={`status-${log.id}`}
                                  status={
                                    log.status === "success"
                                      ? "success"
                                      : log.status === "partially_successful"
                                        ? "warning"
                                        : log.status === "failed"
                                          ? "critical"
                                          : "info"
                                  }
                                >
                                  {log.status === "partially_successful"
                                    ? "partially successful"
                                    : log.status}
                                </Badge>,
                                <Text
                                  key={`summary-${log.id}`}
                                  variant="bodySm"
                                >
                                  {summaryText}
                                </Text>,
                                new Date(log.startedAt).toLocaleString(),
                                duration ? `${duration}s` : "In progress",
                                <Button
                                  key={`view-${log.id}`}
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

            {(actionData?.logs ||
              (backgroundStatus?.completedAt && backgroundStatus?.logs)) &&
              showLogs && (
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
                          {(
                            actionData?.logs ||
                            backgroundStatus?.logs ||
                            []
                          ).map((log, index) => (
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
                        : selectedLogDetails.status === "partially_successful"
                          ? "warning"
                          : selectedLogDetails.status === "failed"
                            ? "critical"
                            : "info"
                    }
                  >
                    {selectedLogDetails.status === "partially_successful"
                      ? "partially successful"
                      : selectedLogDetails.status}
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
                  <>
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
                    <InlineStack gap="400">
                      <Text variant="bodyMd" fontWeight="semibold">
                        Duration:
                      </Text>
                      <Text variant="bodyMd">
                        {(() => {
                          const start = new Date(selectedLogDetails.startedAt);
                          const end = new Date(selectedLogDetails.completedAt);
                          const duration = end - start;
                          const seconds = Math.floor(duration / 1000);
                          const minutes = Math.floor(seconds / 60);
                          const remainingSeconds = seconds % 60;
                          return minutes > 0
                            ? `${minutes}m ${remainingSeconds}s`
                            : `${seconds}s`;
                        })()}
                      </Text>
                    </InlineStack>
                  </>
                )}
              </BlockStack>

              {selectedLogDetails.parsedSummary &&
                Object.keys(selectedLogDetails.parsedSummary).length > 0 && (
                  <Card>
                    <BlockStack gap="300">
                      <Text variant="headingMd" as="h3">
                        Summary
                      </Text>
                      <Text variant="bodySm" color="subdued">
                        Overview of sync operations and results
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

                            // Handle different value types safely
                            let displayValue = value;
                            if (typeof value === "object" && value !== null) {
                              if (key === "importedDefaultMenus") {
                                displayValue = Array.isArray(value)
                                  ? `${value.length} items`
                                  : "Object";
                              } else if (key === "errors") {
                                // Display error messages properly
                                if (Array.isArray(value)) {
                                  displayValue = value.map((error, index) => (
                                    <Text
                                      key={index}
                                      variant="bodySm"
                                      color="critical"
                                    >
                                      • {error}
                                    </Text>
                                  ));
                                } else {
                                  displayValue = "Object";
                                }
                              } else {
                                displayValue = JSON.stringify(value);
                              }
                            } else if (
                              typeof value === "string" ||
                              typeof value === "number"
                            ) {
                              displayValue = value;
                            } else {
                              displayValue = String(value);
                            }

                            return (
                              <Box key={key}>
                                <InlineStack gap="200">
                                  <Text variant="bodyMd" fontWeight="semibold">
                                    {displayKey}:
                                  </Text>
                                  {key === "errors" &&
                                  Array.isArray(displayValue) ? (
                                    <BlockStack gap="100">
                                      {displayValue}
                                    </BlockStack>
                                  ) : (
                                    <Text variant="bodyMd">{displayValue}</Text>
                                  )}
                                </InlineStack>
                              </Box>
                            );
                          });
                        })()}
                      </BlockStack>
                    </BlockStack>
                  </Card>
                )}

              {/* Show key operations summary */}
              {selectedLogDetails.parsedLogs &&
                selectedLogDetails.parsedLogs.length > 0 && (
                  <Card>
                    <BlockStack gap="300">
                      <Text variant="headingMd" as="h3">
                        Key Operations
                      </Text>
                      <Text variant="bodySm" color="subdued">
                        Most important operations from this sync run
                      </Text>

                      {/* Successful operations */}
                      {(() => {
                        const successfulOps =
                          selectedLogDetails.parsedLogs.filter(
                            (log) => log.success || log.message?.includes("✅"),
                          );
                        return successfulOps.length > 0 ? (
                          <BlockStack gap="200">
                            <Text
                              variant="bodyMd"
                              fontWeight="semibold"
                              color="success"
                            >
                              ✅ Successful Operations ({successfulOps.length})
                            </Text>
                            <BlockStack gap="100">
                              {successfulOps.slice(0, 5).map((log, index) => (
                                <Text
                                  key={index}
                                  variant="bodySm"
                                  color="success"
                                >
                                  • {log.message.replace(/^\[.*?\] /, "")}
                                </Text>
                              ))}
                              {successfulOps.length > 5 && (
                                <Text variant="bodySm" color="subdued">
                                  ... and {successfulOps.length - 5} more
                                  successful operations
                                </Text>
                              )}
                            </BlockStack>
                          </BlockStack>
                        ) : null;
                      })()}

                      {/* Failed operations */}
                      {(() => {
                        const failedOps = selectedLogDetails.parsedLogs.filter(
                          (log) => log.error || log.message?.includes("❌"),
                        );
                        return failedOps.length > 0 ? (
                          <BlockStack gap="200">
                            <Text
                              variant="bodyMd"
                              fontWeight="semibold"
                              color="critical"
                            >
                              ❌ Failed Operations ({failedOps.length})
                            </Text>
                            <BlockStack gap="100">
                              {failedOps.slice(0, 5).map((log, index) => (
                                <Text
                                  key={index}
                                  variant="bodySm"
                                  color="critical"
                                >
                                  • {log.message.replace(/^\[.*?\] /, "")}
                                </Text>
                              ))}
                              {failedOps.length > 5 && (
                                <Text variant="bodySm" color="subdued">
                                  ... and {failedOps.length - 5} more failed
                                  operations
                                </Text>
                              )}
                            </BlockStack>
                          </BlockStack>
                        ) : null;
                      })()}

                      {/* Skipped operations */}
                      {(() => {
                        const skippedOps = selectedLogDetails.parsedLogs.filter(
                          (log) => log.skipped || log.message?.includes("⚠️"),
                        );
                        return skippedOps.length > 0 ? (
                          <BlockStack gap="200">
                            <Text
                              variant="bodyMd"
                              fontWeight="semibold"
                              color="caution"
                            >
                              ⚠️ Skipped Operations ({skippedOps.length})
                            </Text>
                            <BlockStack gap="100">
                              {skippedOps.slice(0, 3).map((log, index) => (
                                <Text
                                  key={index}
                                  variant="bodySm"
                                  color="caution"
                                >
                                  • {log.message.replace(/^\[.*?\] /, "")}
                                </Text>
                              ))}
                              {skippedOps.length > 3 && (
                                <Text variant="bodySm" color="subdued">
                                  ... and {skippedOps.length - 3} more skipped
                                  operations
                                </Text>
                              )}
                            </BlockStack>
                          </BlockStack>
                        ) : null;
                      })()}
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
                      <Text variant="bodySm" color="subdued">
                        Showing {selectedLogDetails.parsedLogs.length}{" "}
                        operations from this sync run
                      </Text>
                      <Scrollable style={{ height: "400px" }}>
                        <BlockStack gap="100">
                          {selectedLogDetails.parsedLogs.map((log, index) => {
                            const isSuccess =
                              log.success === true ||
                              log.message?.includes("✅");
                            const isError =
                              log.success === false ||
                              log.error ||
                              log.message?.includes("❌");
                            const isSkipped =
                              log.skipped === true ||
                              log.message?.includes("⚠️");
                            const isInfo =
                              log.message?.includes("📋") ||
                              log.message?.includes("🔧") ||
                              log.message?.includes("🎉");

                            return (
                              <Box
                                key={index}
                                padding="300"
                                borderColor={
                                  isSuccess
                                    ? "success"
                                    : isError
                                      ? "critical"
                                      : isSkipped
                                        ? "warning"
                                        : "border-subdued"
                                }
                                borderWidth="025"
                                borderRadius="200"
                                background={
                                  isSuccess
                                    ? "surface-success-subdued"
                                    : isError
                                      ? "surface-critical-subdued"
                                      : isSkipped
                                        ? "surface-caution-subdued"
                                        : "surface-subdued"
                                }
                              >
                                <BlockStack gap="200">
                                  <InlineStack gap="200" align="space-between">
                                    <Text
                                      variant="bodySm"
                                      color={
                                        isSuccess
                                          ? "success"
                                          : isError
                                            ? "critical"
                                            : isSkipped
                                              ? "warning"
                                              : undefined
                                      }
                                      fontWeight={
                                        isInfo ? "semibold" : undefined
                                      }
                                    >
                                      {log.message}
                                    </Text>
                                    {log.timestamp && (
                                      <Text variant="captionMd" color="subdued">
                                        {new Date(
                                          log.timestamp,
                                        ).toLocaleTimeString()}
                                      </Text>
                                    )}
                                  </InlineStack>

                                  {/* Show log type and additional details */}
                                  {(log.type || log.details || log.error) && (
                                    <BlockStack gap="100">
                                      {log.type && (
                                        <Badge
                                          status={
                                            isSuccess
                                              ? "success"
                                              : isError
                                                ? "critical"
                                                : isSkipped
                                                  ? "attention"
                                                  : "info"
                                          }
                                        >
                                          {log.type.replace(/_/g, " ")}
                                        </Badge>
                                      )}

                                      {log.error && (
                                        <Text
                                          variant="captionMd"
                                          color="critical"
                                        >
                                          ❌ {log.error}
                                        </Text>
                                      )}

                                      {log.details &&
                                        typeof log.details === "object" && (
                                          <Box
                                            padding="200"
                                            background="surface"
                                            borderRadius="100"
                                          >
                                            <Text
                                              variant="captionMd"
                                              color="subdued"
                                              fontFamily="mono"
                                            >
                                              {JSON.stringify(
                                                log.details,
                                                null,
                                                2,
                                              )}
                                            </Text>
                                          </Box>
                                        )}
                                    </BlockStack>
                                  )}
                                </BlockStack>
                              </Box>
                            );
                          })}
                        </BlockStack>
                      </Scrollable>
                    </BlockStack>
                  </Card>
                )}

              {(!selectedLogDetails.parsedLogs ||
                selectedLogDetails.parsedLogs.length === 0) && (
                <Card>
                  <BlockStack gap="300">
                    <Text variant="headingMd" as="h3">
                      Detailed Logs
                    </Text>
                    <Text variant="bodyMd" color="subdued">
                      No detailed logs available for this sync run
                    </Text>
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
