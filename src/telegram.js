/**
 * Telegram Module v7
 *
 * FORMAT CHUẨN NHÓM TELEGRAM:
 * Admin gửi ẢNH kèm CAPTION 5 dòng:
 *   myhanh1233
 *   09431231244
 *   CKFP5e0h
 *   Chưa nhận được
 *   Lý do chưa nhận được hoặc thông tin khác  ← dòng 5 (ghi chú, tùy chọn)
 *
 * Admin cập nhật → REPLY vào tin ảnh:
 *   Đã nhận được ✅
 *   (kèm lý do nếu có)
 */

const axios = require("axios");
const { computeHash, downloadImage, findMatchingInvoice } = require("./imageMatch");
const logger = require("./logger");

const TELEGRAM_API = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`;
const GROUP_ID     = process.env.TELEGRAM_GROUP_ID;
const CACHE_TTL    = 7 * 24 * 60 * 60 * 1000;

const imageCache = new Map(); // msgId → entry
const textCache  = new Map(); // msgId → entry (reply)
const replyIndex = new Map(); // parentId → [childId]

const STATUS_KW = [
  "Đã lên điểm","Chưa lên điểm",
  "Đã nhận được","Chưa nhận được",
  "Đã thanh toán","Chờ thanh toán",
  "Đang xử lý","Đã xử lý",
  "Thành công","Thất bại",
  "Đã hủy","Hoàn tiền",
  "Lỗi thanh toán","Đang kiểm tra",
];

function detectStatus(text) {
  if (!text) return null;
  const t = text.toLowerCase();
  return STATUS_KW.find(s => t.includes(s.toLowerCase())) || null;
}

function normCK(ck) {
  return (ck||"").toUpperCase().replace(/[^A-Z0-9]/g,"");
}

function isPhone(s) {
  return /^(0|\+84)\d{9,10}$/.test(s.replace(/\s/g,""));
}

function cleanPhone(v) {
  const d = v.replace(/\D/g,"");
  return (d.startsWith("84") && d.length===11) ? "0"+d.slice(2) : d;
}

function isCKCode(s) {
  return /^[A-Za-z0-9]{4,20}$/.test(s) && /[A-Za-z]/.test(s) && /[0-9]/.test(s);
}

/**
 * Parse caption 5 dòng:
 *   Dòng 1: username       → không phải SĐT, không phải CK, không phải status
 *   Dòng 2: SĐT            → nhận dạng bằng format số điện thoại
 *   Dòng 3: CK code        → chữ + số, 4-20 ký tự
 *   Dòng 4: Trạng thái     → khớp với STATUS_KW
 *   Dòng 5+: Ghi chú/lý do → toàn bộ phần còn lại sau trạng thái
 */
function parseCaption(text) {
  if (!text) return {};
  const lines = text.split(/\n+/).map(l => l.trim()).filter(Boolean);

  let username = null, phone = null, ckCode = null, status = null;
  const noteLines = [];
  let statusFound = false;

  for (const line of lines) {
    // Đã tìm thấy status → phần còn lại là ghi chú
    if (statusFound) {
      noteLines.push(line);
      continue;
    }
    // Nhận dạng SĐT
    if (!phone && isPhone(line)) {
      phone = cleanPhone(line);
      continue;
    }
    // Nhận dạng trạng thái
    const s = detectStatus(line);
    if (s && !status) {
      status = s;
      statusFound = true;
      // Nếu dòng này còn nội dung ngoài status → là ghi chú inline
      const remainder = line.replace(new RegExp(s,"gi"),"").replace(/[✅❌⏳🔄↩️⚠️📋]/g,"").trim();
      if (remainder) noteLines.push(remainder);
      continue;
    }
    // Nhận dạng CK code
    if (!ckCode && isCKCode(line)) {
      ckCode = normCK(line);
      continue;
    }
    // Còn lại là username (dòng đầu tiên chưa được nhận dạng)
    if (!username) {
      username = line;
    }
  }

  // Tìm CK trong nội dung dạng "ACB;48525327;CKFP5e0h"
  if (!ckCode) {
    const m = text.match(/;([A-Za-z]{2,}[0-9][A-Za-z0-9]{1,})\b/);
    if (m) ckCode = normCK(m[1]);
  }

  const note = noteLines.join(" | ").trim() || null;

  return { username, phone, ckCode, status, note };
}

/**
 * Parse reply text — có thể gồm:
 *   Đã nhận được ✅
 *   hoặc
 *   Đã nhận được ✅\nLý do cụ thể ở đây
 */
function parseReplyText(text) {
  if (!text) return { status: null, note: null };
  const lines = text.split(/\n+/).map(l => l.trim()).filter(Boolean);
  const status = detectStatus(text);
  let note = null;
  if (status && lines.length > 1) {
    // Dòng đầu là status, dòng sau là ghi chú
    const firstLineHasStatus = detectStatus(lines[0]);
    if (firstLineHasStatus) {
      note = lines.slice(1).join(" | ").trim() || null;
    } else {
      note = lines.filter(l => !detectStatus(l)).join(" | ").trim() || null;
    }
  }
  return { status, note };
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
  if (!ch.includes(childId)) ch.push(childId);
  replyIndex.set(parentId, ch);
}

// Lấy status + note mới nhất trong toàn bộ reply chain
function getLatestStatus(rootId) {
  let best = { status: null, note: null, date: 0 };

  function traverse(id) {
    const e = imageCache.get(id) || textCache.get(id);
    if (e?.status && e.message_date > best.date) {
      best = { status: e.status, note: e.note||null, date: e.message_date };
    }
    for (const cid of (replyIndex.get(id)||[])) traverse(cid);
  }

  traverse(rootId);
  return best.status ? best : null;
}

// ── Index 1 message ───────────────────────────────────────────────────────────
async function indexMessage(msg) {
  if (!msg || String(msg.chat.id) !== String(GROUP_ID)) return;

  const msgId    = msg.message_id;
  const parentId = msg.reply_to_message?.message_id || null;
  const msgDate  = msg.date * 1000;
  const text     = msg.text || "";
  const caption  = msg.caption || "";

  if (parentId) addReply(parentId, msgId);

  // ── Tin có ẢNH → parse caption 5 dòng ─────────────────────────────────────
  const photo = getLargestPhoto(msg.photo);
  if (photo) {
    const parsed = parseCaption(caption);
    logger.info("Image caption parsed", { msgId, ...parsed });

    try {
      const url = await getFileUrl(photo.file_id);
      if (url) {
        const buf = await downloadImage(url);
        if (buf) {
          const hash = await computeHash(buf);
          imageCache.set(msgId, {
            message_id: msgId, parent_id: parentId, message_date: msgDate,
            hash, file_id: photo.file_id,
            ck_code:  parsed.ckCode,
            username: parsed.username,
            phone:    parsed.phone,
            status:   parsed.status,
            note:     parsed.note,
            cached_at: Date.now(),
          });
          logger.info("Image indexed", {
            msgId, ck: parsed.ckCode, phone: parsed.phone,
            status: parsed.status, note: parsed.note,
          });
        }
      }
    } catch(e) { logger.error("Image index error",{msgId,error:e.message}); }
    return;
  }

  // ── Tin TEXT (reply cập nhật) → parse status + note ───────────────────────
  const { status, note } = parseReplyText(text);
  if (status || parentId) {
    textCache.set(msgId, {
      message_id: msgId, parent_id: parentId, message_date: msgDate,
      status, note, cached_at: Date.now(),
    });
    if (status) logger.info("Reply indexed", { msgId, status, note, parentId });
  }
}

// ── Tìm theo CK ───────────────────────────────────────────────────────────────
function findByCK(searchCK) {
  const n = normCK(searchCK);
  if (!n || n.length < 4) return null;

  for (const [id, entry] of imageCache) {
    if (Date.now() - entry.cached_at > CACHE_TTL) { imageCache.delete(id); continue; }
    const ck = entry.ck_code || "";
    if (ck === n || ck.includes(n) || n.includes(ck)) {
      logger.info("CK match", { id, ck, search: n });
      return id;
    }
  }
  return null;
}

// ── MAIN SEARCH ───────────────────────────────────────────────────────────────
async function searchInvoiceByAll({ username, phone, transferContent, imageBuffer }) {
  logger.info("=== SEARCH ===", { username, phone, transferContent });

  await fetchRecentMessages(300);
  logger.info("Cache", { images: imageCache.size, texts: textCache.size });

  // 1. Tìm theo CK
  let rootId = findByCK(transferContent);

  // 2. Fallback: khớp ảnh
  if (!rootId && imageBuffer) {
    const imgs = [];
    for (const [,img] of imageCache) if (img.hash) imgs.push(img);
    if (imgs.length) {
      const m = await findMatchingInvoice(imageBuffer, imgs);
      if (m) { rootId = m.message_id; logger.info("Image match", { rootId }); }
    }
  }

  if (!rootId) {
    logger.info("NOT FOUND", { transferContent });
    return { found: false };
  }

  // Lấy status + note mới nhất từ reply chain
  const latest = getLatestStatus(rootId);
  const root   = imageCache.get(rootId);

  return {
    found:  true,
    status: latest?.status || root?.status || "Đang xử lý",
    note:   latest?.note   || root?.note   || null,
  };
}

async function fetchRecentMessages(limit=300) {
  try {
    const res = await axios.get(`${TELEGRAM_API}/getUpdates`,{
      params:{limit,timeout:10,allowed_updates:["message"]},timeout:25000,
    });
    const sorted=[...(res.data.result||[])].sort((a,b)=>(a.message?.date||0)-(b.message?.date||0));
    for(const u of sorted) if(u.message) await indexMessage(u.message);
    logger.info(`Fetched ${sorted.length}, images:${imageCache.size}, texts:${textCache.size}`);
  } catch(e){ logger.error("Fetch error",{error:e.message}); }
}

async function processUpdate(update) {
  const msg = update.message||update.channel_post;
  if (msg) await indexMessage(msg);
}

async function setupWebhook(webhookUrl) {
  const res = await axios.post(`${TELEGRAM_API}/setWebhook`,{
    url:`${webhookUrl}/webhook/telegram`,allowed_updates:["message"],drop_pending_updates:false,
  });
  logger.info("Webhook set",{ok:res.data.ok});
}

const telegramService = {
  processUpdate, setupWebhook,
  getCacheStats: ()=>({ images:imageCache.size, texts:textCache.size }),
};

module.exports = { searchInvoiceByAll, telegramService };
