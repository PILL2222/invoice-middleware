/**
 * Script test toàn bộ luồng không cần Postman.
 * Chạy: node scripts/test-lookup.js
 *
 * Trước khi test: đảm bảo đã gửi tin vào nhóm Telegram theo format đúng.
 */

require("dotenv").config();
const axios = require("axios");

const BASE_URL = process.env.PUBLIC_URL || "http://localhost:3000";

// ── Dữ liệu test — thay bằng dữ liệu thật trong nhóm Telegram ────────────────
const TEST_CASES = [
  {
    name: "✅ Tìm thấy hóa đơn",
    body: {
      chat_id: "test-001",
      customer_id: "KH001",
      phone: "0901234567",
      invoice_id: "HD-TEST-001",
    },
    expect: "responded",
  },
  {
    name: "⚠️ Không tìm thấy → chuyển agent",
    body: {
      chat_id: "test-002",
      customer_id: "KH999",
      phone: "0999999999",
      invoice_id: "HD-KHONG-TON-TAI",
    },
    expect: "transferred",
  },
  {
    name: "❌ Thiếu trường bắt buộc",
    body: {
      chat_id: "test-003",
      phone: "0901234567",
      // Thiếu customer_id và invoice_id
    },
    expect: "error",
  },
];

async function runTests() {
  console.log(`\n🧪 Bắt đầu test — Server: ${BASE_URL}\n${"─".repeat(50)}`);

  // Test health trước
  try {
    const health = await axios.get(`${BASE_URL}/health`);
    console.log(`✅ Health check: ${JSON.stringify(health.data)}\n`);
  } catch {
    console.error(`❌ Server không chạy tại ${BASE_URL}\n`);
    process.exit(1);
  }

  // Chạy từng test case
  for (const tc of TEST_CASES) {
    process.stdout.write(`Test: ${tc.name} ... `);
    try {
      const res = await axios.post(`${BASE_URL}/webhook/livechat`, tc.body, {
        headers: { "Content-Type": "application/json" },
        validateStatus: () => true, // Không throw lỗi HTTP
      });

      const action = res.data?.action;
      const passed =
        (tc.expect === "responded" && action === "responded") ||
        (tc.expect === "transferred" && action === "transferred") ||
        (tc.expect === "error" && res.status === 400);

      if (passed) {
        console.log(`PASS ✅  (${JSON.stringify(res.data)})`);
      } else {
        console.log(`FAIL ❌  (expected: ${tc.expect}, got: status=${res.status} body=${JSON.stringify(res.data)})`);
      }
    } catch (err) {
      console.log(`ERROR 💥  ${err.message}`);
    }
  }

  console.log(`\n${"─".repeat(50)}\n✅ Hoàn thành test\n`);
}

runTests();
