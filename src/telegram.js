/**
 * Telegram Module v4 — fix matching logic
 * Format nhóm thực tế:
 *   [Ảnh HĐ]
 *   Text: "User: myhanh1234\nSĐT: 0943424234\nCK: CKFP5e0h"
 *   Reply: "CKFP5e0h\nmyhanh1234 » Đã lên điểm"
 */
const axios = require("axios");
const { computeHash, downloadImage, findMatchingInvoice } = require("./imageMatch");
const logger = require("./logger");

const TELEGRAM_API = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`;
const GROUP_ID = process.env.TELEGRAM_GROUP_ID;
const CACHE_TTL = 7 * 24 * 60 * 60 * 1000;

// imageCache: message_id → { hash, ... }
// ckCache: ck_code → { status, note, message_id, username, phone }  ← INDEX CHÍNH
// replyIndex: parent_id → [child_id, ...]
const imageCache  = new Map();
const ckCache     = new Map(); // KEY: normalized CK code
const replyIndex  = new Map();
const messageStore = new Map(); // lưu toàn bộ message để traverse

// Status keywords — thêm các từ thực tế trong nhóm
const STATUS_KW = [
  "Đã lên điểm", "Chưa lên điểm",
  "Đã nhận được", "Chưa nhận được",
  "Đã thanh toán", "Chờ thanh toán",
  "Đang xử lý", "Đã hủy", "Hoàn tiền",
  "Lỗi thanh toán", "Thành công", "Thất bại",
  "Đã xử lý", "Đang kiểm tra",
];

function detectStatus(text) {
  if (!text) return null;
  const t = text.toLowerCase();
  return STATUS_KW.find(s => t.includes(s.toLowerCase())) || null;
}
function extractNote(text) {
  const m = (text||"").match(/(?:ghi chú|note|lý do)[:\s]+([^\n]+)/i);
  return m?.[1]?.trim() || null;
}

// Normalize CK code để so sánh
function normalizeCK(ck) {
  return (ck||"").toUpperCase().replace(/[^A-Z0-9]/g,"");
}

// Trích CK code từ text — nhiều format
function extractCKCodes(text) {
  if (!text) return [];
  const codes = new Set();
  // Format: "CK: CKFP5e0h" hoặc "Nội dung: ACB;48525327;CKFP5e0h"
  const labeled = text.match(/(?:ck|nội dung|nd|content)[:\s]+([A-Za-z0-9;:_\-\.]{4,60})/gi);
  if (labeled) {
    labeled.forEach(m => {
      const val = m.replace(/^(?:ck|nội dung|nd|content)[:\s]+/i,"").trim();
      // Tách theo dấu ; hoặc : để lấy từng phần
      val.split(/[;:,\s]+/).forEach(part => {
        if (/^[A-Za-z0-9]{4,20}$/.test(part)) codes.add(normalizeCK(part));
      });
      codes.add(normalizeCK(val));
    });
  }
  // Standalone code: chuỗi chữ+số 4-20 ký tự
  const standalone = text.match(/\b([A-Z]{2,6}[0-9A-Za-z]{2,14})\b/g);
  if (standalone) standalone.forEach(c => codes.add(normalizeCK(c)));
  
  return [...codes].filter(c => c.length >= 4);
}

function extractPhone(text) {
  return text?.match(/\b(0\d{9,10})\b/)?.[1] || null;
}
function extractUsername(text) {
  const m = text?.match(/(?:user|tk|tài khoản|username)[:\s]+([A-Za-z0-9@._\-]{2,50})/i);
  return m?.[1]?.trim() || null;
}

function getLargestPhoto(photos) {
  if (!photos?.length) return null;
  return photos.reduce((a,b) => a.file_size > b.file_size ? a : b);
}
async function getFileUrl(fileId) {
  try {
    const res = await axios.get(`${TELEGRAM_API}/getFile`,{params:{file_id:fileId},timeout:10000});
    const path = res.data.result?.file_path;
    return path ? `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${path}` : null;
  } catch(e) { return null; }
}
function addReply(parentId, childId) {
  const ch = replyIndex.get(parentId)||[];
  if(!ch.includes(childId)) ch.push(childId);
  replyIndex.set(parentId, ch);
}

// Lấy status mới nhất từ reply chain
function getLatestStatusInChain(rootId) {
  let latest = { status: null, note: null, date: 0 };
  function traverse(id) {
    const msg = messageStore.get(id);
    if (msg?.status && msg.message_date > latest.date) {
      latest = { status: msg.status, note: msg.note, date: msg.message_date };
    }
    for (const cid of (replyIndex.get(id)||[])) traverse(cid);
  }
  traverse(rootId);
  return latest.status ? latest : null;
}

async function indexMessage(msg) {
  if (!msg || String(msg.chat.id) !== String(GROUP_ID)) return;
  const msgId   = msg.message_id;
  const parentId = msg.reply_to_message?.message_id || null;
  const msgDate  = msg.date * 1000;
  const text     = msg.text || msg.caption || "";
  if (parentId) addReply(parentId, msgId);

  const status   = detectStatus(text);
  const ckCodes  = extractCKCodes(text);
  const phone    = extractPhone(text);
  const username = extractUsername(text);

  // Lưu vào messageStore
  const entry = { message_id:msgId, parent_id:parentId, message_date:msgDate,
    status, note:extractNote(text), ck_codes:ckCodes, phone, username, cached_at:Date.now() };
  messageStore.set(msgId, entry);

  // Index CK codes vào ckCache
  ckCodes.forEach(ck => {
    const existing = ckCache.get(ck);
    // Chỉ overwrite nếu mới hơn
    if (!existing || msgDate > existing.message_date) {
      ckCache.set(ck, { ...entry, ck });
      logger.info("CK indexed", { ck, msgId, status, phone });
    }
  });

  // Tin có ảnh → hash
  const photo = getLargestPhoto(msg.photo);
  if (photo) {
    try {
      const url = await getFileUrl(photo.file_id);
      if (url) {
        const buf = await downloadImage(url);
        if (buf) {
          const hash = await computeHash(buf);
          imageCache.set(msgId, { ...entry, hash, file_id:photo.file_id });
          logger.info("Image indexed", { msgId });
        }
      }
    } catch(e) { logger.error("Image index error",{msgId,error:e.message}); }
  }
}

// ── SEARCH CHÍNH ──────────────────────────────────────────────────────────────
async function searchInvoiceByAll({ username, phone, transferContent, imageBuffer }) {
  // 1. Tìm theo CK code (chính xác và nhanh nhất)
  const searchCK = normalizeCK(transferContent);
  logger.info("Searching", { searchCK, phone, username });

  let rootMessageId = null;

  // Tìm exact match trước
  if (ckCache.has(searchCK)) {
    const entry = ckCache.get(searchCK);
    rootMessageId = entry.parent_id || entry.message_id;
    logger.info("Exact CK match", { searchCK, rootMessageId });
  }

  // Tìm partial match nếu không có exact
  if (!rootMessageId) {
    for (const [ck, entry] of ckCache) {
      if (ck.includes(searchCK) || searchCK.includes(ck)) {
        rootMessageId = entry.parent_id || entry.message_id;
        logger.info("Partial CK match", { ck, searchCK, rootMessageId });
        break;
      }
    }
  }

  // 2. Nếu không tìm được bằng CK → thử image matching
  if (!rootMessageId && imageBuffer) {
    logger.info("CK not found, trying image match");
    const validImages = [];
    for (const [,img] of imageCache) if(img.hash) validImages.push(img);
    if (validImages.length === 0) {
      await fetchRecentMessages(300);
      for (const [,img] of imageCache) if(img.hash) validImages.push(img);
    }
    const imgMatch = await findMatchingInvoice(imageBuffer, validImages);
    if (imgMatch) {
      rootMessageId = imgMatch.message_id;
      logger.info("Image match found", { rootMessageId });
    }
  }

  if (!rootMessageId) {
    logger.info("No match found", { searchCK, ckCacheSize: ckCache.size });
    return { found: false };
  }

  // 3. Lấy status mới nhất từ reply chain
  const latestStatus = getLatestStatusInChain(rootMessageId);
  const rootEntry = messageStore.get(rootMessageId);

  // Tìm status gần nhất
  let finalStatus = latestStatus?.status || rootEntry?.status || null;
  let finalNote   = latestStatus?.note   || rootEntry?.note   || null;

  // Nếu không tìm thấy status trong chain → tìm trong reply của parent
  if (!finalStatus && rootEntry?.parent_id) {
    const parentLatest = getLatestStatusInChain(rootEntry.parent_id);
    finalStatus = parentLatest?.status;
    finalNote   = parentLatest?.note;
  }

  return {
    found:  true,
    status: finalStatus || "Đang xử lý",
    note:   finalNote,
  };
}

async function fetchRecentMessages(limit=300) {
  try {
    const res = await axios.get(`${TELEGRAM_API}/getUpdates`,{
      params:{limit,timeout:10,allowed_updates:["message"]},timeout:20000,
    });
    const sorted=[...(res.data.result||[])].sort((a,b)=>(a.message?.date||0)-(b.message?.date||0));
    for(const u of sorted) if(u.message) await indexMessage(u.message);
    logger.info(`Fetched ${sorted.length} updates, ckCache:${ckCache.size}, imageCache:${imageCache.size}`);
  } catch(e){logger.error("Fetch error",{error:e.message});}
}

async function processUpdate(update) {
  const msg = update.message||update.channel_post;
  if(msg) await indexMessage(msg);
}
async function setupWebhook(webhookUrl) {
  const res=await axios.post(`${TELEGRAM_API}/setWebhook`,{url:`${webhookUrl}/webhook/telegram`,allowed_updates:["message"],drop_pending_updates:false});
  logger.info("Webhook set",{result:res.data});
}
const telegramService={processUpdate,setupWebhook,getCacheStats:()=>({images:imageCache.size,cks:ckCache.size,messages:messageStore.size})};
module.exports={searchInvoiceByAll,telegramService};
