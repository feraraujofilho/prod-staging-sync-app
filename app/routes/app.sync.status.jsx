import { authenticate } from "../shopify.server";
import prisma from "../db.server";

// Resource route used for polling background sync status
export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const logId = url.searchParams.get("logId");

  if (!logId) {
    return { error: "Missing logId" };
  }

  const log = await prisma.syncLog.findUnique({ where: { id: logId } });

  if (!log || log.shop !== session.shop) {
    return { error: "Log not found" };
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

  return {
    id: log.id,
    status: log.status,
    startedAt: log.startedAt,
    completedAt: log.completedAt,
    summary,
    logs,
  };
};

