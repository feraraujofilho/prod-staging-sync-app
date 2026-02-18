import { authenticate } from "../shopify.server";
import prisma from "../db.server";

// Resource route used for polling background sync status
export const loader = async ({ request }) => {
  try {
    const { session } = await authenticate.admin(request);
    const url = new URL(request.url);
    const logId = url.searchParams.get("logId");

    if (!logId) {
      return new Response(JSON.stringify({ error: "Missing logId" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const log = await prisma.syncLog.findUnique({ where: { id: logId } });

    if (!log || log.shop !== session.shop) {
      return new Response(JSON.stringify({ error: "Log not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Safely parse stored JSON fields
    let summary = null;
    let logs = [];
    try {
      summary = log.summary ? JSON.parse(log.summary) : null;
    } catch {
      summary = { message: log.summary };
    }
    try {
      logs = log.logs ? JSON.parse(log.logs) : [];
    } catch {
      logs = [];
    }

    return new Response(
      JSON.stringify({
        id: log.id,
        status: log.status,
        startedAt: log.startedAt,
        completedAt: log.completedAt,
        summary,
        logs,
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store, no-cache, must-revalidate",
          Pragma: "no-cache",
          Expires: "0",
        },
      },
    );
  } catch (error) {
    console.error("Error fetching sync status:", error);
    return new Response(
      JSON.stringify({
        error: "Internal server error",
        details: error.message,
      }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      },
    );
  }
};
