/**
 * Chạy script này 1 lần duy nhất sau khi server đã deploy.
 * Đăng ký webhook để Telegram tự đẩy tin về server.
 *
 * Cách chạy:
 *   node scripts/setup-webhook.js
 */

require("dotenv").config();
const axios = require("axios");

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const PUBLIC_URL = process.env.PUBLIC_URL;

if (!TOKEN || !PUBLIC_URL) {
  console.error("❌ Thiếu TELEGRAM_BOT_TOKEN hoặc PUBLIC_URL trong .env");
  process.exit(1);
}

async function main() {
  const webhookUrl = `${PUBLIC_URL}/webhook/telegram`;
  console.log(`\n🔗 Đang đăng ký webhook: ${webhookUrl}\n`);

  try {
    // Xóa webhook cũ nếu có
    await axios.post(`https://api.telegram.org/bot${TOKEN}/deleteWebhook`);
    console.log("✅ Đã xóa webhook cũ");

    // Đăng ký webhook mới
    const res = await axios.post(`https://api.telegram.org/bot${TOKEN}/setWebhook`, {
      url: webhookUrl,
      allowed_updates: ["message"],
      drop_pending_updates: true,
    });

    if (res.data.ok) {
      console.log("✅ Đăng ký webhook thành công!\n");
    } else {
      console.error("❌ Thất bại:", res.data);
    }

    // Kiểm tra lại
    const info = await axios.get(`https://api.telegram.org/bot${TOKEN}/getWebhookInfo`);
    const w = info.data.result;
    console.log("📋 Thông tin webhook hiện tại:");
    console.log(`   URL:           ${w.url}`);
    console.log(`   Pending:       ${w.pending_update_count}`);
    console.log(`   Last error:    ${w.last_error_message || "Không có"}`);
    console.log(`   Last error at: ${w.last_error_date ? new Date(w.last_error_date * 1000).toLocaleString() : "—"}\n`);

  } catch (err) {
    console.error("❌ Lỗi:", err.message);
  }
}

main();
