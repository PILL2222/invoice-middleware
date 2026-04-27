/**
 * LiveChat API Integration
 * - Send messages to customers
 * - Transfer chat to human agent
 */

const axios = require("axios");
const logger = require("./logger");

const LC_API = "https://api.livechatinc.com/v3.5/agent/action";
const LC_AUTH = Buffer.from(
  `${process.env.LIVECHAT_ACCOUNT_ID}:${process.env.LIVECHAT_PAT}`
).toString("base64");

const lcClient = axios.create({
  baseURL: LC_API,
  headers: {
    Authorization: `Basic ${LC_AUTH}`,
    "Content-Type": "application/json",
    "X-Region": process.env.LIVECHAT_REGION || "fra", // fra | dal
  },
  timeout: 10000,
});

// Retry wrapper with exponential backoff
async function withRetry(fn, retries = 3, delay = 500) {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i === retries - 1) throw err;
      // Don't retry on 4xx errors (client errors)
      if (err.response?.status >= 400 && err.response?.status < 500) throw err;
      await new Promise((r) => setTimeout(r, delay * Math.pow(2, i)));
      logger.warn(`Retrying LiveChat API (attempt ${i + 2})`, { error: err.message });
    }
  }
}

/**
 * Send a message to the customer in the chat.
 */
async function sendLivechatMessage(chatId, text) {
  await withRetry(() =>
    lcClient.post("/send_event", {
      chat_id: chatId,
      event: {
        type: "message",
        text,
        visibility: "all",
      },
    })
  );
  logger.info("Message sent to LiveChat", { chat_id: chatId });
}

/**
 * Transfer chat to a real human agent.
 * @param {string} chatId
 * @param {string} internalNote - Note visible only to agents
 */
async function transferToAgent(chatId, internalNote = "") {
  try {
    // Step 1: Send private note for agent context
    if (internalNote) {
      await withRetry(() =>
        lcClient.post("/send_event", {
          chat_id: chatId,
          event: {
            type: "message",
            text: `[BOT NOTE] ${internalNote}`,
            visibility: "agents",
          },
        })
      );
    }

    // Step 2: Deactivate bot routing (remove bot from chat)
    await withRetry(() =>
      lcClient.post("/transfer_chat", {
        id: chatId,
        target: {
          type: "group",
          ids: [parseInt(process.env.LIVECHAT_AGENT_GROUP_ID || "0")],
        },
      })
    );

    logger.info("Chat transferred to agent", { chat_id: chatId });
  } catch (err) {
    logger.error("Failed to transfer chat", { chat_id: chatId, error: err.message });
    // Fallback: at minimum send a message so customer isn't left hanging
    await sendLivechatMessage(
      chatId,
      "Đang kết nối với nhân viên hỗ trợ, vui lòng chờ trong giây lát..."
    );
  }
}

module.exports = { sendLivechatMessage, transferToAgent };
