import { randomUUID } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const SIGNUPS_TABLE = process.env.SIGNUPS_TABLE_NAME;
const FEEDBACK_TABLE = process.env.FEEDBACK_TABLE_NAME;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
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

  try {
    await ddb.send(new PutCommand({
      TableName: SIGNUPS_TABLE,
      Item: { email, createdAt: meta.now, userAgent: meta.userAgent, sourceIp: meta.sourceIp },
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

  try {
    await ddb.send(new PutCommand({
      TableName: FEEDBACK_TABLE,
      Item: {
        feedbackId: randomUUID(),
        createdAt: meta.now,
        name,
        email,
        message,
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

export const handler = async (event) => {
  const method = event?.requestContext?.http?.method ?? "GET";
  if (method === "OPTIONS") return { statusCode: 204, headers: CORS, body: "" };
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

  const path = event?.requestContext?.http?.path ?? event?.rawPath ?? "";
  if (path.endsWith("/signup")) return handleSignup(payload, meta);
  if (path.endsWith("/feedback")) return handleFeedback(payload, meta);
  return reply(404, { error: "not found" });
};
