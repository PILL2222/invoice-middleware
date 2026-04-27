// auth.js - Webhook signature validation
// Nếu LIVECHAT_WEBHOOK_SECRET để trống → bỏ qua validation (dùng khi test)
const crypto = require("crypto");

function validateWebhookSignature(body, signature) {
  const secret = process.env.LIVECHAT_WEBHOOK_SECRET;
  if (!secret || secret.trim() === "") return true; // Bỏ qua nếu chưa set
  if (!signature) return false;
  try {
    const expected = crypto
      .createHmac("sha256", secret)
      .update(JSON.stringify(body))
      .digest("hex");
    return crypto.timingSafeEqual(
      Buffer.from(signature.replace("sha256=", "")),
      Buffer.from(expected)
    );
  } catch(e) {
    return false;
  }
}

module.exports = { validateWebhookSignature };
