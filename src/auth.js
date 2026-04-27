// src/auth.js - Webhook signature validation
const crypto = require("crypto");

function validateWebhookSignature(body, signature) {
  if (!process.env.LIVECHAT_WEBHOOK_SECRET) return true; // Skip if not configured
  if (!signature) return false;
  const expected = crypto
    .createHmac("sha256", process.env.LIVECHAT_WEBHOOK_SECRET)
    .update(JSON.stringify(body))
    .digest("hex");
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

module.exports = { validateWebhookSignature };
