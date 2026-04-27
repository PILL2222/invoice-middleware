/**
 * Telegram Integration Module
 * - Stores incoming group messages to in-memory cache
 * - Tracks REPLY CHAINS: admin updates status by replying to original message
 * - searchInvoiceInTelegram() always returns the LATEST status in the chain
 *
 * Reply chain example in Telegram group:
 *   Msg #100: "HD-001 | 0901234567 | Chưa nhận được"        ← tin gốc
 *     └─ Msg #105: "Chưa nhận được (lần 2)"                 ← reply
 *          └─ Msg #112: "Chưa nhận được (lần 3)"            ← reply
 *               └─ Msg #118: "Đã nhận được ✅"              ← reply mới nhất → DÙNG CÁI NÀY
 *
 * Bot sẽ trả về: "Đã nhận được" (msg #118)
 */

const axios = require("axios");
const logger = require("./logger");

const TELEGRAM_API = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`;
const GROUP_ID = process.env.TELEGRAM_GROUP_ID;

// ── In-memory stores ──────────────────────────────────────────────────────────
// invoiceIndex: Map<normalizedInvoiceId, messageId>  — maps invoice → root message
// messageCache: Map<messageId, MessageEntry>          — all messages (root + replies)
// replyIndex:   Map<parentMessageId, messageId[]>     — parent → list of child reply IDs
const invoiceIndex = new Map(); // invoice_id → root message_id
const messageCache = new Map(); // message_id → full entry
const replyIndex   = new Map(); // parent_id  → [child_id, ...]

const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Patterns to extract invoice data from Telegram messages.
 * Adjust these regex patterns to match your group's actual message format.
 *
 * Example message formats your team might use:
 *   "HD-2024-001 | 0901234567 | Nguyễn Văn A | Đã thanh toán"
 *   "Hóa đơn: HD001 - SĐT: 0912345678 - TT: Chờ thanh toán"
 *   "#HD2024001 SDT 0901234567 → Đã thanh toán ✅"
 */
const INVOICE_PATTERNS = [
  // Pattern 1: "HD-001 | 0901234567 | Tên KH | Trạng thái"
  /(?:HD|hd|Invoice|invoice)[:\-#\s]*([A-Z0-9\-_]+)[\s|,\-]+(\d{9,11})[\s|,\-]+([^\|,\-\n]+)?[\s|,\-]+([\w\sÀ-ỹđĐ]+)/i,

  // Pattern 2: "Mã HĐ: XXX, SĐT: 09xxx, TT: ..."
  /(?:mã\s*hđ|hóa\s*đơn|invoice)[:\s#]*([A-Z0-9\-_]+).*?(?:sđt|phone|điện thoại)[:\s]*(\d{9,11}).*?(?:tt|trạng thái|status)[:\s]*([\w\sÀ-ỹđĐ✅❌⏳🔄]+)/is,

  // Pattern 3: Hashtag format "#HD001 0901234567 Đã thanh toán"
  /#([A-Z0-9\-_]+)\s+(\d{9,11})\s+([\w\sÀ-ỹđĐ]+)/i,
];

// Tất cả trạng thái có thể có — thứ tự ưu tiên (cụ thể hơn đặt trước)
const STATUS_KEYWORDS = [
  "Đã nhận được",
  "Chưa nhận được",
  "Đã thanh toán",
  "Chờ thanh toán",
  "Đang xử lý",
  "Đang chuyển khoản",
  "Đã hủy",
  "Hoàn tiền",
  "Lỗi thanh toán",
];

// ── Parse invoice từ tin nhắn gốc (cần có invoice_id + phone) ────────────────
function parseRootInvoiceMessage(text, messageDate) {
  if (!text) return null;

  for (const pattern of INVOICE_PATTERNS) {
    const match = text.match(pattern);
    if (match) {
      const detectedStatus = STATUS_KEYWORDS.find((s) =>
        text.toLowerCase().includes(s.toLowerCase())
      );
      return {
        invoice_id: match[1]?.trim().toUpperCase(),
        phone: match[2]?.replace(/\D/g, ""),
        customer_name: match[3]?.trim(),
        status: detectedStatus || match[4]?.trim() || "Không xác định",
        raw_text: text,
        message_date: messageDate,
        note: extractNote(text),
      };
    }
  }

  // Fallback
  const invoiceId = text.match(/\b([A-Z]{2,4}[\-_]?\d{3,10})\b/)?.[1];
  const phone = text.match(/\b(0\d{9,10})\b/)?.[1];
  const status = STATUS_KEYWORDS.find((s) => text.toLowerCase().includes(s.toLowerCase()));
  if (invoiceId && phone && status) {
    return { invoice_id: invoiceId.toUpperCase(), phone, status, raw_text: text, message_date: messageDate };
  }
  return null;
}

// ── Parse trạng thái từ tin nhắn REPLY (chỉ cần có status keyword) ───────────
function parseReplyStatus(text, messageDate) {
  if (!text) return null;
  const status = STATUS_KEYWORDS.find((s) => text.toLowerCase().includes(s.toLowerCase()));
  if (!status) return null;
  return {
    status,
    raw_text: text,
    message_date: messageDate,
    note: extractNote(text),
  };
}

function extractNote(text) {
  const noteMatch = text.match(/(?:ghi chú|note|lý do)[:\s]+([^\n]+)/i);
  return noteMatch?.[1]?.trim() || null;
}

function normalizePhone(phone) {
  const digits = String(phone).replace(/\D/g, "");
  if (digits.startsWith("84") && digits.length === 11) return "0" + digits.slice(2);
  return digits;
}

// ── Đăng ký 1 message vào các index ──────────────────────────────────────────
function indexMessage(msg) {
  const text = msg.text || msg.caption || "";
  const msgDate = msg.date * 1000;
  const msgId = msg.message_id;
  const parentId = msg.reply_to_message?.message_id || null;

  if (parentId) {
    // Đây là tin REPLY → gắn vào replyIndex của parent
    const children = replyIndex.get(parentId) || [];
    if (!children.includes(msgId)) children.push(msgId);
    replyIndex.set(parentId, children);

    // Lưu vào messageCache kèm trạng thái (nếu có)
    const replyData = parseReplyStatus(text, msgDate);
    if (replyData) {
      messageCache.set(msgId, {
        ...replyData,
        message_id: msgId,
        parent_id: parentId,
        is_reply: true,
        cached_at: Date.now(),
      });
      logger.debug("Indexed reply message", { msgId, parentId, status: replyData.status });
    }
  } else {
    // Đây là tin GỐC → parse đầy đủ invoice_id + phone
    const rootData = parseRootInvoiceMessage(text, msgDate);
    if (rootData) {
      messageCache.set(msgId, {
        ...rootData,
        message_id: msgId,
        parent_id: null,
        is_reply: false,
        cached_at: Date.now(),
      });
      // Đánh index để tìm nhanh theo invoice_id
      const key = normalizeInvoiceKey(rootData.invoice_id);
      invoiceIndex.set(key, msgId);
      logger.debug("Indexed root invoice", { msgId, invoice_id: rootData.invoice_id });
    }
  }
}

function normalizeInvoiceKey(id) {
  return (id || "").toUpperCase().replace(/\s/g, "");
}

// ── Lấy trạng thái MỚI NHẤT từ chuỗi reply của 1 tin gốc ─────────────────────
// Thuật toán: duyệt cây reply theo thứ tự thời gian, lấy lá (leaf) mới nhất
function getLatestStatusInChain(rootMessageId) {
  const root = messageCache.get(rootMessageId);
  if (!root) return null;

  // DFS tìm node mới nhất có status
  let latest = root; // fallback là tin gốc

  function traverse(messageId) {
    const children = replyIndex.get(messageId) || [];
    for (const childId of children) {
      const child = messageCache.get(childId);
      if (!child) continue;
      // Chỉ cập nhật nếu tin này mới hơn
      if (child.message_date > latest.message_date && child.status) {
        latest = child;
      }
      traverse(childId); // đệ quy xuống sâu hơn
    }
  }

  traverse(rootMessageId);

  // Trả về thông tin đầy đủ: base từ root (invoice_id, phone, customer_name) + status từ latest
  return {
    ...root,               // invoice_id, phone, customer_name từ tin gốc
    status: latest.status, // trạng thái MỚI NHẤT
    note: latest.note || root.note,
    status_updated_at: latest.message_date,
    status_message_id: latest.message_id,
    chain_depth: countChainDepth(rootMessageId),
  };
}

function countChainDepth(messageId, depth = 0) {
  const children = replyIndex.get(messageId) || [];
  if (children.length === 0) return depth;
  return Math.max(...children.map((c) => countChainDepth(c, depth + 1)));
}

// ── Search chính: tìm invoice rồi lấy status mới nhất ────────────────────────
function searchCache({ phone, invoice_id }) {
  const normalPhone = normalizePhone(phone);
  const normalInvoice = normalizeInvoiceKey(invoice_id);

  // Tìm root message theo invoice_id (ưu tiên exact match)
  let rootId = invoiceIndex.get(normalInvoice);

  // Nếu không exact → scan toàn bộ để tìm partial match
  if (!rootId) {
    for (const [key, msgId] of invoiceIndex) {
      if (key.includes(normalInvoice) || normalInvoice.includes(key)) {
        rootId = msgId;
        break;
      }
    }
  }

  if (!rootId) return { found: false };

  const root = messageCache.get(rootId);
  if (!root) return { found: false };

  // Kiểm tra TTL
  if (Date.now() - root.cached_at > CACHE_TTL_MS) {
    evictChain(rootId);
    return { found: false };
  }

  // Xác minh phone khớp
  const rootPhone = normalizePhone(root.phone || "");
  const phoneMatch =
    rootPhone === normalPhone || rootPhone.endsWith(normalPhone.slice(-8));
  if (!phoneMatch) return { found: false };

  // Lấy trạng thái MỚI NHẤT trong chuỗi reply
  const result = getLatestStatusInChain(rootId);
  return { found: true, ...result };
}

// ── Dọn dẹp toàn bộ chuỗi khi hết TTL ───────────────────────────────────────
function evictChain(rootId) {
  function evict(msgId) {
    const children = replyIndex.get(msgId) || [];
    children.forEach(evict);
    messageCache.delete(msgId);
    replyIndex.delete(msgId);
  }
  evict(rootId);
  // Xóa khỏi invoiceIndex
  for (const [key, id] of invoiceIndex) {
    if (id === rootId) { invoiceIndex.delete(key); break; }
  }
  logger.debug("Evicted chain", { rootId });
}

// ── Fetch recent messages từ Telegram (fallback nếu cache trống) ──────────────
async function fetchRecentMessages(limit = 200) {
  try {
    const response = await axios.get(`${TELEGRAM_API}/getUpdates`, {
      params: { limit, timeout: 10, allowed_updates: ["message"] },
      timeout: 15000,
    });

    const updates = response.data.result || [];
    // Quan trọng: xử lý THEO THỨ TỰ THỜI GIAN để root được index trước reply
    const sorted = [...updates].sort((a, b) => (a.message?.date || 0) - (b.message?.date || 0));

    for (const update of sorted) {
      const msg = update.message;
      if (!msg || String(msg.chat.id) !== String(GROUP_ID)) continue;
      indexMessage(msg);
    }

    logger.info(`Fetched ${updates.length} updates, indexed ${invoiceIndex.size} invoices`);
  } catch (err) {
    logger.error("Failed to fetch Telegram updates", { error: err.message });
    throw err;
  }
}

// ── Main search (exported) ────────────────────────────────────────────────────
async function searchInvoiceInTelegram(params) {
  let result = searchCache(params);
  if (result.found) return result;

  logger.info("Cache miss, fetching fresh messages", { invoice_id: params.invoice_id });
  await fetchRecentMessages(200);
  return searchCache(params);
}

// ── Process incoming Telegram webhook (real-time) ─────────────────────────────
async function processUpdate(update) {
  const msg = update.message || update.channel_post;
  if (!msg || String(msg.chat.id) !== String(GROUP_ID)) return;

  indexMessage(msg);

  // Log có ích khi debug
  const isReply = !!msg.reply_to_message;
  const status = parseReplyStatus(msg.text || msg.caption || "", msg.date * 1000)?.status;
  if (isReply && status) {
    logger.info("Status update via reply", {
      message_id: msg.message_id,
      parent_id: msg.reply_to_message.message_id,
      new_status: status,
    });
  }
}

// ── Setup Telegram webhook ────────────────────────────────────────────────────
async function setupWebhook(webhookUrl) {
  try {
    const response = await axios.post(`${TELEGRAM_API}/setWebhook`, {
      url: `${webhookUrl}/webhook/telegram`,
      allowed_updates: ["message"],
      drop_pending_updates: false,
    });
    logger.info("Telegram webhook set", { result: response.data });
    return response.data;
  } catch (err) {
    logger.error("Failed to set Telegram webhook", { error: err.message });
    throw err;
  }
}

// ── Cache stats ───────────────────────────────────────────────────────────────
function getCacheStats() {
  return {
    total_messages: messageCache.size,
    total_invoices: invoiceIndex.size,
    total_reply_chains: replyIndex.size,
  };
}

const telegramService = { processUpdate, setupWebhook, getCacheStats };

module.exports = { searchInvoiceInTelegram, telegramService, parseRootInvoiceMessage, parseReplyStatus };
