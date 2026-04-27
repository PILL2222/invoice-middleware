/**
 * Telegram Module v3 — lưu ảnh + nội dung CK + reply chain
 * Đối soát 4 tiêu chí: username + phone + image + transfer content
 */
const axios = require("axios");
const { computeHash, downloadImage, findMatchingInvoice } = require("./imageMatch");
const logger = require("./logger");

const TELEGRAM_API = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`;
const GROUP_ID = process.env.TELEGRAM_GROUP_ID;
const CACHE_TTL = 7 * 24 * 60 * 60 * 1000;

// imageCache: message_id → { hash, transferContent, username, phone, status, ... }
// statusCache: message_id → { status, note, parent_id, message_date }
// replyIndex: parent_id → [child_id, ...]
const imageCache  = new Map();
const statusCache = new Map();
const replyIndex  = new Map();

const STATUS_KW = [
  "Đã nhận được","Chưa nhận được","Đã thanh toán","Chờ thanh toán",
  "Đang xử lý","Đã hủy","Hoàn tiền","Lỗi thanh toán",
];

function detectStatus(text) {
  if (!text) return null;
  return STATUS_KW.find(s => text.toLowerCase().includes(s.toLowerCase())) || null;
}
function extractNote(text) {
  const m = (text||"").match(/(?:ghi chú|note|lý do)[:\s]+([^\n]+)/i);
  return m?.[1]?.trim() || null;
}

// Trích nội dung chuyển khoản từ text (VD: CKFP5e0h, ACB;48525327;CKFP5e0h)
function extractTransferContent(text) {
  if (!text) return null;
  // Tìm chuỗi sau "nội dung:" hoặc "nd:"
  const labeled = text.match(/(?:nội dung|nd|ck|content)[:\s]+([A-Za-z0-9;._\-]{4,50})/i);
  if (labeled) return labeled[1].trim();
  // Tìm pattern dạng "ACB;số;CK..." hoặc standalone code
  const ckPattern = text.match(/\b([A-Z]{2,5}[0-9A-Za-z]{4,20})\b/);
  if (ckPattern) return ckPattern[1];
  return null;
}

// Trích username, phone từ caption/text của admin
function extractMeta(text) {
  const phone = text?.match(/\b(0\d{9,10})\b/)?.[1] || null;
  const username = text?.match(/(?:user|tên|tk|account)[:\s]+([A-Za-z0-9@._\-]{2,50})/i)?.[1] || null;
  return { phone, username };
}

function getLargestPhoto(photos) {
  if (!photos?.length) return null;
  return photos.reduce((a,b) => a.file_size > b.file_size ? a : b);
}
async function getFileUrl(fileId) {
  try {
    const res = await axios.get(`${TELEGRAM_API}/getFile`, { params:{file_id:fileId}, timeout:10000 });
    const path = res.data.result?.file_path;
    return path ? `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${path}` : null;
  } catch(e) { return null; }
}
function addReply(parentId, childId) {
  const ch = replyIndex.get(parentId) || [];
  if (!ch.includes(childId)) ch.push(childId);
  replyIndex.set(parentId, ch);
}
function getLatestStatus(rootId) {
  const root = statusCache.get(rootId) || imageCache.get(rootId);
  if (!root) return null;
  let latest = root;
  function traverse(id) {
    for (const cid of (replyIndex.get(id)||[])) {
      const child = statusCache.get(cid);
      if (child && child.message_date > (latest.message_date||0)) latest = child;
      traverse(cid);
    }
  }
  traverse(rootId);
  return latest;
}

async function indexMessage(msg) {
  if (!msg || String(msg.chat.id) !== String(GROUP_ID)) return;
  const msgId = msg.message_id;
  const parentId = msg.reply_to_message?.message_id || null;
  const msgDate = msg.date * 1000;
  const text = msg.text || msg.caption || "";
  if (parentId) addReply(parentId, msgId);

  // Tin có ảnh → hash + lưu metadata
  const photo = getLargestPhoto(msg.photo);
  if (photo) {
    try {
      const url = await getFileUrl(photo.file_id);
      if (url) {
        const buf = await downloadImage(url);
        if (buf) {
          const hash = await computeHash(buf);
          const meta = extractMeta(text);
          const ck   = extractTransferContent(text);
          imageCache.set(msgId, {
            message_id: msgId, parent_id: parentId, file_id: photo.file_id,
            hash, status: detectStatus(text)||null, note: extractNote(text),
            transferContent: ck, phone: meta.phone, username: meta.username,
            message_date: msgDate, cached_at: Date.now(),
          });
          logger.info("Indexed image", { msgId, ck, phone: meta.phone });
        }
      }
    } catch(e) { logger.error("Image index error",{msgId,error:e.message}); }
    return;
  }

  // Tin văn bản → lưu status + transfer content
  const status = detectStatus(text);
  const ck = extractTransferContent(text);
  const meta = extractMeta(text);
  if (status || ck) {
    statusCache.set(msgId, {
      message_id: msgId, parent_id: parentId, status: status||null,
      note: extractNote(text), transferContent: ck,
      phone: meta.phone, username: meta.username,
      message_date: msgDate, cached_at: Date.now(),
    });
    logger.info("Indexed status/CK", { msgId, status, ck });
  }
}

// ── Đối soát toàn bộ 4 tiêu chí ─────────────────────────────────────────────
async function searchInvoiceByAll({ username, phone, transferContent, imageBuffer }) {
  // 1. Tìm theo nội dung CK (chính xác nhất)
  let matchedMessageId = null;

  // Tìm trong imageCache và statusCache theo transfer content
  const ckLower = (transferContent||"").toLowerCase();

  for (const [id, entry] of imageCache) {
    if (Date.now() - entry.cached_at > CACHE_TTL) { imageCache.delete(id); continue; }
    const entryCK = (entry.transferContent||"").toLowerCase();
    if (ckLower && entryCK && (entryCK.includes(ckLower) || ckLower.includes(entryCK))) {
      matchedMessageId = id;
      logger.info("CK match in imageCache", { id, transferContent });
      break;
    }
  }

  if (!matchedMessageId) {
    for (const [id, entry] of statusCache) {
      if (Date.now() - entry.cached_at > CACHE_TTL) { statusCache.delete(id); continue; }
      const entryCK = (entry.transferContent||"").toLowerCase();
      if (ckLower && entryCK && (entryCK.includes(ckLower) || ckLower.includes(entryCK))) {
        matchedMessageId = entry.parent_id || id;
        logger.info("CK match in statusCache", { id, transferContent });
        break;
      }
    }
  }

  // 2. Nếu không tìm được theo CK → thử khớp ảnh
  if (!matchedMessageId && imageBuffer) {
    const validImages = [];
    for (const [, img] of imageCache) if (img.hash) validImages.push(img);
    if (validImages.length === 0) {
      await fetchRecentMessages(200);
      for (const [, img] of imageCache) if (img.hash) validImages.push(img);
    }
    const { findMatchingInvoice } = require("./imageMatch");
    const imgMatch = await findMatchingInvoice(imageBuffer, validImages);
    if (imgMatch) {
      matchedMessageId = imgMatch.message_id;
      logger.info("Image match fallback", { matchedMessageId });
    }
  }

  if (!matchedMessageId) return { found: false };

  // 3. Lấy trạng thái mới nhất từ reply chain
  const latest = getLatestStatus(matchedMessageId);
  const base   = imageCache.get(matchedMessageId) || statusCache.get(matchedMessageId);

  return {
    found:  true,
    status: latest?.status || base?.status || "Chưa cập nhật",
    note:   latest?.note   || base?.note   || null,
  };
}

async function fetchRecentMessages(limit=200) {
  try {
    const res = await axios.get(`${TELEGRAM_API}/getUpdates`, {
      params: { limit, timeout:10, allowed_updates:["message"] }, timeout:20000,
    });
    const sorted = [...(res.data.result||[])].sort((a,b)=>(a.message?.date||0)-(b.message?.date||0));
    for (const u of sorted) if (u.message) await indexMessage(u.message);
    logger.info(`Fetched ${sorted.length} updates, ${imageCache.size} images, ${statusCache.size} statuses`);
  } catch(e) { logger.error("Fetch error",{error:e.message}); }
}

async function processUpdate(update) {
  const msg = update.message || update.channel_post;
  if (msg) await indexMessage(msg);
}

async function setupWebhook(webhookUrl) {
  const res = await axios.post(`${TELEGRAM_API}/setWebhook`, {
    url:`${webhookUrl}/webhook/telegram`, allowed_updates:["message"], drop_pending_updates:false,
  });
  logger.info("Webhook set", { result:res.data });
}

const telegramService = {
  processUpdate, setupWebhook,
  getCacheStats: () => ({ images:imageCache.size, statuses:statusCache.size, replies:replyIndex.size }),
};

module.exports = { searchInvoiceByAll, telegramService };
