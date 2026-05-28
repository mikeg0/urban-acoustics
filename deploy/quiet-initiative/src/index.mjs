import { randomUUID } from "node:crypto";
import { DynamoDBClient, DescribeTableCommand } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";

const ddbClient = new DynamoDBClient({});
const ddb = DynamoDBDocumentClient.from(ddbClient);
const SIGNUPS_TABLE = process.env.SIGNUPS_TABLE_NAME;
const FEEDBACK_TABLE = process.env.FEEDBACK_TABLE_NAME;
const PAGE_VISITS_TABLE = process.env.PAGE_VISITS_TABLE_NAME;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const FEEDBACK_TOPICS = new Set(["story", "data", "privacy", "volunteer", "other"]);

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Max-Age": "86400",
};

const reply = (status, body) => ({
  statusCode: status,
  headers: { ...CORS, "content-type": "application/json" },
  body: JSON.stringify(body),
});

async function handleSignup(payload, meta) {
  const email = (payload.email || "").trim().toLowerCase();
  if (!email || email.length > 254 || !EMAIL_RE.test(email)) {
    return reply(400, { error: "invalid email" });
  }

  const name = (payload.name || "").trim();
  if (!name || name.length > 100) {
    return reply(400, { error: "invalid name" });
  }

  const neighborhood = (payload.neighborhood || "").trim();
  if (!neighborhood || neighborhood.length > 80) {
    return reply(400, { error: "invalid neighborhood" });
  }

  const comment = (payload.comment || "").trim();
  if (comment.length > 1000) {
    return reply(400, { error: "comment too long" });
  }

  const isResident = payload.isResident !== false;

  try {
    await ddb.send(new PutCommand({
      TableName: SIGNUPS_TABLE,
      Item: {
        email,
        name,
        neighborhood,
        comment: comment || undefined,
        isResident,
        createdAt: meta.now,
        userAgent: meta.userAgent,
        sourceIp: meta.sourceIp,
      },
      ConditionExpression: "attribute_not_exists(email)",
    }));
  } catch (err) {
    if (err?.name === "ConditionalCheckFailedException") {
      return reply(200, { ok: true, already: true });
    }
    console.error("ddb error", err);
    return reply(500, { error: "server error" });
  }

  return reply(200, { ok: true });
}

async function handleSignupCount() {
  try {
    const out = await ddbClient.send(new DescribeTableCommand({ TableName: SIGNUPS_TABLE }));
    const count = out?.Table?.ItemCount ?? 0;
    return reply(200, { count });
  } catch (err) {
    console.error("describe-table error", err);
    return reply(500, { error: "server error" });
  }
}

async function handleFeedback(payload, meta) {
  const name = (payload.name || "").trim();
  if (!name || name.length > 100) {
    return reply(400, { error: "invalid name" });
  }

  const email = (payload.email || "").trim().toLowerCase();
  if (!email || email.length > 254 || !EMAIL_RE.test(email)) {
    return reply(400, { error: "invalid email" });
  }

  const message = (payload.message || "").trim();
  if (!message || message.length > 4000) {
    return reply(400, { error: "invalid message" });
  }

  const topic = (payload.topic || "").trim().toLowerCase();
  if (topic && !FEEDBACK_TOPICS.has(topic)) {
    return reply(400, { error: "invalid topic" });
  }

  const block = (payload.block || "").trim();
  if (block.length > 120) {
    return reply(400, { error: "block too long" });
  }

  const whenWoken = (payload.whenWoken || "").trim();
  if (whenWoken.length > 120) {
    return reply(400, { error: "whenWoken too long" });
  }

  try {
    await ddb.send(new PutCommand({
      TableName: FEEDBACK_TABLE,
      Item: {
        feedbackId: randomUUID(),
        createdAt: meta.now,
        name,
        email,
        message,
        topic: topic || undefined,
        block: block || undefined,
        whenWoken: whenWoken || undefined,
        userAgent: meta.userAgent,
        sourceIp: meta.sourceIp,
      },
    }));
  } catch (err) {
    console.error("ddb error", err);
    return reply(500, { error: "server error" });
  }

  return reply(200, { ok: true });
}

function clampDimension(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return undefined;
  const i = Math.trunc(n);
  if (i < 0 || i > 10000) return undefined;
  return i;
}

async function handlePageView(payload, meta) {
  const referrer = (payload.referrer || "").trim().slice(0, 2048);
  const path = (payload.path || "").trim().slice(0, 2048);
  const screenWidth = clampDimension(payload.screenWidth);
  const screenHeight = clampDimension(payload.screenHeight);

  try {
    await ddb.send(new PutCommand({
      TableName: PAGE_VISITS_TABLE,
      Item: {
        visitId: randomUUID(),
        createdAt: meta.now,
        sourceIp: meta.sourceIp,
        userAgent: meta.userAgent,
        referrer: referrer || undefined,
        path: path || undefined,
        screenWidth,
        screenHeight,
      },
    }));
  } catch (err) {
    console.error("pageview ddb error", err);
  }

  return reply(200, { ok: true });
}

export const handler = async (event) => {
  const method = event?.requestContext?.http?.method ?? "GET";
  if (method === "OPTIONS") return { statusCode: 204, headers: CORS, body: "" };

  const path = event?.requestContext?.http?.path ?? event?.rawPath ?? "";

  if (method === "GET") {
    if (path.endsWith("/signups/count")) return handleSignupCount();
    return reply(405, { error: "method not allowed" });
  }

  if (method !== "POST") return reply(405, { error: "method not allowed" });

  let payload;
  try {
    payload = event.body ? JSON.parse(event.body) : {};
  } catch {
    return reply(400, { error: "invalid json" });
  }

  const meta = {
    now: new Date().toISOString(),
    userAgent: event?.requestContext?.http?.userAgent ?? "",
    sourceIp: event?.requestContext?.http?.sourceIp ?? "",
  };

  if (path.endsWith("/signup")) return handleSignup(payload, meta);
  if (path.endsWith("/feedback")) return handleFeedback(payload, meta);
  if (path.endsWith("/pageview")) return handlePageView(payload, meta);
  return reply(404, { error: "not found" });
};
