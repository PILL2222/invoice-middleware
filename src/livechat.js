/**
 * LiveChat API Integration - fixed region + author detection
 */
const axios = require("axios");
const logger = require("./logger");

// LiveChat Agent API - dùng đúng region từ PAT
// PAT format: "us-south1:xxx" hoặc "fra:xxx" hoặc plain token
const PAT   = process.env.LIVECHAT_PAT || "";
const EMAIL = process.env.LIVECHAT_ACCOUNT_ID || "";

// Tự detect region từ PAT
function getApiBase() {
  if (PAT.startsWith("us-south1:")) return "https://api.livechatinc.com";
  if (PAT.startsWith("fra:"))       return "https://api.livechatinc.com";
  if (PAT.startsWith("dal:"))       return "https://api.livechatinc.com";
  return "https://api.livechatinc.com";
}

function getAuthHeader() {
  const token = Buffer.from(`${EMAIL}:${PAT}`).toString("base64");
  return `Basic ${token}`;
}

const lcClient = axios.create({
  baseURL: `${getApiBase()}/v3.5/agent/action`,
  headers: {
    "Content-Type": "application/json",
    "Authorization": getAuthHeader(),
  },
  timeout: 10000,
});

// Retry với backoff
async function withRetry(fn, retries = 3, delay = 500) {
  for (let i = 0; i < retries; i++) {
    try { return await fn(); }
    catch (err) {
      if (i === retries - 1) throw err;
      if (err.response?.status >= 400 && err.response?.status < 500) throw err;
      await new Promise(r => setTimeout(r, delay * Math.pow(2, i)));
      logger.warn(`Retry ${i+2}`, { error: err.message });
    }
  }
}

async function sendLivechatMessage(chatId, text) {
  try {
    await withRetry(() => lcClient.post("/send_event", {
      chat_id: chatId,
      event: { type: "message", text, visibility: "all" },
    }));
    logger.info("Message sent", { chatId });
  } catch (err) {
    logger.error("sendLivechatMessage failed", {
      chatId,
      status: err.response?.status,
      data: JSON.stringify(err.response?.data).slice(0, 200),
      error: err.message,
    });
  }
}

async function transferToAgent(chatId, internalNote = "") {
  try {
    if (internalNote) {
      await withRetry(() => lcClient.post("/send_event", {
        chat_id: chatId,
        event: { type: "message", text: `[BOT] ${internalNote}`, visibility: "agents" },
      }));
    }
    const groupId = parseInt(process.env.LIVECHAT_AGENT_GROUP_ID || "0");
    await withRetry(() => lcClient.post("/transfer_chat", {
      id: chatId,
      target: { type: "group", ids: [groupId] },
    }));
    logger.info("Transferred to agent", { chatId });
  } catch (err) {
    logger.error("transferToAgent failed", { chatId, error: err.message });
    await sendLivechatMessage(chatId, "Đang kết nối nhân viên hỗ trợ, vui lòng chờ...");
  }
}

// Kiểm tra author_id có phải customer không
// Customer: UUID format (8-4-4-4-12)
// Agent: email format hoặc tên
function isCustomerAuthor(authorId) {
  if (!authorId) return true; // mặc định là customer nếu không rõ
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (uuidPattern.test(authorId)) return true;  // UUID → customer
  if (authorId.includes("@") || authorId.includes(".com") || authorId.includes("gmail")) return false; // email → agent
  return true;
}

module.exports = { sendLivechatMessage, transferToAgent, isCustomerAuthor };
