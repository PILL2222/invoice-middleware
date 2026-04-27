/**
 * LiveChat ↔ Telegram Invoice Middleware
 * Handles webhook from LiveChat, searches Telegram group for invoice status,
 * returns result or escalates to human agent.
 */

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const { searchInvoiceInTelegram } = require("./telegram");
const { sendLivechatMessage, transferToAgent } = require("./livechat");
const { validateWebhookSignature } = require("./auth");
const logger = require("./logger");

const app = express();
const PORT = process.env.PORT || 3000;

// ── Security Middleware ────────────────────────────────────────────────────────
app.use(helmet());
app.use(cors({ origin: process.env.ALLOWED_ORIGINS?.split(",") || "*" }));
app.use(express.json({ limit: "10kb" }));

// Rate limiting: 60 requests/minute per IP
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, please try again later." },
});
app.use("/webhook", limiter);

// ── Health Check ──────────────────────────────────────────────────────────────
app.get("/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// ── Main Webhook: LiveChat → Middleware ───────────────────────────────────────
/**
 * LiveChat sends a webhook when a tagged message arrives.
 * Expected payload (from bot custom form or message extract):
 * {
 *   chat_id: "abc123",
 *   customer_id: "CUST-001",
 *   phone: "0901234567",
 *   invoice_id: "HD-2024-001"
 * }
 */
app.post("/webhook/livechat", async (req, res) => {
  // 1. Validate signature from LiveChat
  const signature = req.headers["x-livechat-signature"];
  if (!validateWebhookSignature(req.body, signature)) {
    logger.warn("Invalid webhook signature", { ip: req.ip });
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { chat_id, customer_id, phone, invoice_id } = req.body;

  // 2. Input validation
  if (!chat_id || !customer_id || !phone || !invoice_id) {
    logger.warn("Missing required fields", req.body);
    return res.status(400).json({ error: "Missing required fields" });
  }

  // Sanitize inputs (prevent injection)
  const cleanPhone = phone.replace(/\D/g, "").slice(0, 11);
  const cleanCustomerId = customer_id.replace(/[^a-zA-Z0-9\-_]/g, "").slice(0, 50);
  const cleanInvoiceId = invoice_id.replace(/[^a-zA-Z0-9\-_]/g, "").slice(0, 50);

  logger.info("Invoice lookup request", {
    chat_id,
    customer_id: cleanCustomerId,
    invoice_id: cleanInvoiceId,
  });

  // 3. Search Telegram group
  let invoiceResult;
  try {
    invoiceResult = await searchInvoiceInTelegram({
      customer_id: cleanCustomerId,
      phone: cleanPhone,
      invoice_id: cleanInvoiceId,
    });
  } catch (err) {
    logger.error("Telegram search failed", { error: err.message });
    // Graceful degradation: transfer to agent instead of returning error
    await transferToAgent(chat_id, "Hệ thống đang bảo trì, chuyển sang hỗ trợ trực tiếp.");
    return res.json({ action: "transferred", reason: "system_error" });
  }

  // 4. Respond based on result
  if (invoiceResult.found) {
    const message = buildStatusMessage(invoiceResult);
    await sendLivechatMessage(chat_id, message);
    logger.info("Invoice found and responded", { invoice_id: cleanInvoiceId });
    return res.json({ action: "responded", status: invoiceResult.status });
  } else {
    // Not found → transfer to real agent
    const transferMsg =
      "Không tìm thấy thông tin hóa đơn phù hợp. Đang chuyển bạn đến nhân viên hỗ trợ...";
    await sendLivechatMessage(chat_id, transferMsg);
    await transferToAgent(chat_id, `Khách cần hỗ trợ hóa đơn: ${cleanInvoiceId} / SĐT: ${cleanPhone}`);
    logger.info("Invoice not found, transferred to agent", { invoice_id: cleanInvoiceId });
    return res.json({ action: "transferred", reason: "not_found" });
  }
});

// ── Telegram Webhook (for storing group messages) ─────────────────────────────
app.post("/webhook/telegram", async (req, res) => {
  const { telegramService } = require("./telegram");
  try {
    await telegramService.processUpdate(req.body);
    res.json({ ok: true });
  } catch (err) {
    logger.error("Telegram webhook error", { error: err.message });
    res.json({ ok: true }); // Always 200 to Telegram to prevent retries
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function buildStatusMessage(result) {
  const statusEmoji = {
    "Đã thanh toán": "✅",
    "Chờ thanh toán": "⏳",
    "Đã hủy": "❌",
    "Đang xử lý": "🔄",
  };
  const emoji = statusEmoji[result.status] || "📋";

  return (
    `${emoji} *Thông tin hóa đơn*\n\n` +
    `📄 Mã HĐ: \`${result.invoice_id}\`\n` +
    `👤 Khách hàng: ${result.customer_name || "N/A"}\n` +
    `📅 Ngày: ${result.date || "N/A"}\n` +
    `💰 Trạng thái: *${result.status}*\n` +
    (result.note ? `📝 Ghi chú: ${result.note}\n` : "") +
    `\nNếu cần hỗ trợ thêm, hãy nhắn tin cho chúng tôi.`
  );
}

// ── Error handlers ────────────────────────────────────────────────────────────
app.use((err, _req, res, _next) => {
  logger.error("Unhandled error", { error: err.message, stack: err.stack });
  res.status(500).json({ error: "Internal server error" });
});

app.listen(PORT, () => {
  logger.info(`Middleware server running on port ${PORT}`);
});

module.exports = app;
