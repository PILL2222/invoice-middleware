/**
 * Telegram Module v8
 * FIX CHÍNH: Cache lưu vào file JSON để tồn tại qua restart
 * Webhook nhận tin realtime → lưu vào cache → tìm kiếm từ cache
 *
 * FORMAT CAPTION (ảnh + 4-5 dòng):
 *   myhanh1233
 *   09431231244
 *   CKFP5e0h
 *   Chưa nhận được
 *   Lý do (tùy chọn)
 *
 * REPLY cập nhật:
 *   Đã nhận được ✅
 *   Ghi chú thêm (tùy chọn)
 */

const axios = require("axios");
const fs    = require("fs");
const path  = require("path");
const { computeHash, downloadImage, findMatchingInvoice } = require("./imageMatch");
const logger = require("./logger");

const TELEGRAM_API = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`;
const GROUP_ID     = process.env.TELEGRAM_GROUP_ID;
const CACHE_TTL    = 7 * 24 * 60 * 60 * 1000;
const CACHE_FILE   = path.join(process.cwd(), "telegram_cache.json");

// In-memory cache
let imageCache = new Map(); // msgId → entry
let textCache  = new Map(); // msgId → entry
let replyIndex = new Map(); // parentId → [childId]

// ── Load/Save cache từ file ───────────────────────────────────────────────────
function saveCache() {
  try {
    const data = {
      images:  [...imageCache.entries()].filter(([,v]) => !v.hash), // Không lưu hash (buffer)
      imagesWithMeta: [...imageCache.entries()].map(([k,v]) => [k, {
        ...v, hash: undefined, // Bỏ hash khi lưu file
      }]),
      texts:   [...textCache.entries()],
      replies: [...replyIndex.entries()],
    };
    fs.writeFileSync(CACHE_FILE, JSON.stringify(data), "utf8");
  } catch(e) { logger.debug("saveCache error", {error:e.message}); }
}

function loadCache() {
  try {
    if (!fs.existsSync(CACHE_FILE)) return;
    const data = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
    if (data.imagesWithMeta) {
      imageCache = new Map(data.imagesWithMeta.map(([k,v]) => [k, {...v, hash: null}]));
    }
    if (data.texts)   textCache  = new Map(data.texts);
    if (data.replies) replyIndex = new Map(data.replies.map(([k,v]) => [k, Array.isArray(v)?v:[v]]));
    logger.info("Cache loaded from file", { images: imageCache.size, texts: textCache.size });
  } catch(e) { logger.debug("loadCache error", {error:e.message}); }
}

// Auto-save mỗi 5 phút
setInterval(saveCache, 5 * 60 * 1000);

// Load ngay khi khởi động
loadCache();

// ── Helpers ───────────────────────────────────────────────────────────────────
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

function parseCaption(text) {
  /**
   * FORMAT CAPTION (ảnh + caption):
   *   Dòng 1: Username       (luôn là dòng đầu)
   *   Dòng 2: SĐT
   *   Dòng 3: Mã CK
   *   Dòng 4: Ghi chú (tùy chọn)
   *   Dòng 5: Trạng thái
   *   Dòng 6+: Ghi chú thêm (tùy chọn)
   */
  if (!text) return {};
  const lines = text.split(/\n+/).map(l => l.trim()).filter(Boolean);

  // Dòng 1 luôn là username
  const username = lines[0] || null;

  let phone=null, ckCode=null, status=null;
  const noteLines=[];

  for (let i=1; i<lines.length; i++) {
    const line = lines[i];

    // Dòng 2: SĐT
    if (!phone && isPhone(line)) { phone=cleanPhone(line); continue; }

    // Dòng 3: CK code (sau khi đã có SĐT, dòng tiếp theo không phải status)
    if (!ckCode && phone && !detectStatus(line) && line.length>=4 && line.length<=30) {
      ckCode=normCK(line); continue;
    }

    // Tìm trạng thái (dòng 5)
    const s = detectStatus(line);
    if (s && !status) { status=s; continue; }

    // Còn lại là ghi chú
    noteLines.push(line);
  }

  // Fallback: tìm CK trong chuỗi dạng "ACB;48525327;CKFP5e0h"
  if (!ckCode) {
    const m = text.match(/;([A-Za-z]{2,}[0-9][A-Za-z0-9]{1,})\b/);
    if (m) ckCode=normCK(m[1]);
  }

  return { username, phone, ckCode, status, note: noteLines.join(" | ")||null };
}

function parseReplyText(text) {
  /**
   * FORMAT REPLY:
   *   Dòng 1: Ghi chú (tùy chọn)
   *   Dòng 2: Ghi chú (tùy chọn)
   *   Dòng 3+: Trạng thái mới
   *
   * Ví dụ:
   *   Khách đã liên hệ xác nhận   ← dòng 1: ghi chú
   *   Đã kiểm tra với kế toán     ← dòng 2: ghi chú
   *   Đã nhận được ✅             ← dòng 3: trạng thái
   */
  if (!text) return { status: null, note: null };
  const lines = text.split(/\n+/).map(l => l.trim()).filter(Boolean);

  if (lines.length === 1) {
    // Chỉ 1 dòng → là trạng thái nếu khớp keyword, còn lại là ghi chú
    const status = detectStatus(lines[0]);
    return { status, note: status ? null : lines[0] };
  }

  if (lines.length === 2) {
    // 2 dòng: dòng 1 = ghi chú, dòng 2 = trạng thái
    const status = detectStatus(lines[1]) || detectStatus(lines[0]);
    if (detectStatus(lines[1])) {
      return { status: detectStatus(lines[1]), note: lines[0] };
    }
    if (detectStatus(lines[0])) {
      return { status: detectStatus(lines[0]), note: lines[1] };
    }
    return { status: null, note: lines.join(" | ") };
  }

  // 3+ dòng: dòng 1+2 = ghi chú, dòng 3+ = trạng thái
  const noteLines = lines.slice(0, 2);
  const statusLines = lines.slice(2).join(" ");
  const status = detectStatus(statusLines) || detectStatus(lines.join(" "));
  const note = noteLines.join(" | ") || null;

  return { status, note: status ? note : null };
}

function getLargestPhoto(photos) {
  if (!photos?.length) return null;
  return photos.reduce((a,b)=>a.file_size>b.file_size?a:b);
}

async function getFileUrl(fileId) {
  try {
    const res=await axios.get(`${TELEGRAM_API}/getFile`,{params:{file_id:fileId},timeout:10000});
    const p=res.data.result?.file_path;
    return p?`https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${p}`:null;
  } catch(e){return null;}
}

function addReply(parentId,childId) {
  const ch=replyIndex.get(parentId)||[];
  if(!ch.includes(childId))ch.push(childId);
  replyIndex.set(parentId,ch);
}

function getLatestStatus(rootId) {
  let best={status:null,note:null,date:0};
  function traverse(id) {
    const e=imageCache.get(id)||textCache.get(id);
    if(e?.status&&e.message_date>best.date) best={status:e.status,note:e.note||null,date:e.message_date};
    for(const cid of (replyIndex.get(id)||[])) traverse(cid);
  }
  traverse(rootId);
  return best.status?best:null;
}

// ── Index message ─────────────────────────────────────────────────────────────
async function indexMessage(msg) {
  if (!msg||String(msg.chat.id)!==String(GROUP_ID)) return;

  const msgId   =msg.message_id;
  const parentId=msg.reply_to_message?.message_id||null;
  const msgDate =msg.date*1000;
  const text    =msg.text||"";
  const caption =msg.caption||"";

  if(parentId) addReply(parentId,msgId);

  // Tin có ảnh
  const photo=getLargestPhoto(msg.photo);
  if(photo){
    const parsed=parseCaption(caption);
    logger.info("Caption parsed",{msgId,...parsed});
    try {
      const url=await getFileUrl(photo.file_id);
      if(url){
        const buf=await downloadImage(url);
        if(buf){
          const hash=await computeHash(buf);
          const entry={
            message_id:msgId,parent_id:parentId,message_date:msgDate,
            hash,file_id:photo.file_id,
            ck_code:parsed.ckCode,username:parsed.username,
            phone:parsed.phone,status:parsed.status,note:parsed.note,
            cached_at:Date.now(),
          };
          imageCache.set(msgId,entry);
          saveCache(); // Lưu ngay khi có ảnh mới
          logger.info("Image indexed",{msgId,ck:parsed.ckCode,phone:parsed.phone,status:parsed.status});
        }
      }
    } catch(e){logger.error("Image index error",{msgId,error:e.message});}
    return;
  }

  // Tin text (reply)
  const{status,note}=parseReplyText(text);
  if(status||parentId){
    textCache.set(msgId,{message_id:msgId,parent_id:parentId,message_date:msgDate,status,note,cached_at:Date.now()});
    if(status){saveCache();logger.info("Reply indexed",{msgId,status,note,parentId});}
  }
}

// Tìm theo CK
function findByCK(searchCK) {
  const n=normCK(searchCK);
  if(!n||n.length<4) return null;
  for(const[id,entry]of imageCache){
    if(Date.now()-entry.cached_at>CACHE_TTL){imageCache.delete(id);continue;}
    const ck=entry.ck_code||"";
    if(ck===n||ck.includes(n)||n.includes(ck)){
      logger.info("CK match",{id,ck,search:n});
      return id;
    }
  }
  return null;
}

// ── MAIN SEARCH ───────────────────────────────────────────────────────────────
async function searchInvoiceByAll({username,phone,transferContent,imageBuffer}){
  logger.info("=== SEARCH ===",{username,phone,transferContent,cacheSize:imageCache.size});

  // 1. Tìm theo CK
  let rootId=findByCK(transferContent);

  // 2. Fallback: khớp ảnh
  if(!rootId&&imageBuffer){
    const imgs=[];
    for(const[,img]of imageCache)if(img.hash)imgs.push(img);
    logger.info("Image match attempt",{validImages:imgs.length});
    if(imgs.length){
      const m=await findMatchingInvoice(imageBuffer,imgs);
      if(m){rootId=m.message_id;logger.info("Image match",{rootId});}
    }
  }

  if(!rootId){logger.info("NOT FOUND",{transferContent,cacheSize:imageCache.size});return{found:false};}

  const latest=getLatestStatus(rootId);
  const root=imageCache.get(rootId);
  return{
    found:true,
    status:latest?.status||root?.status||"Đang xử lý",
    note:latest?.note||root?.note||null,
  };
}

async function processUpdate(update){
  const msg=update.message||update.channel_post;
  if(msg) await indexMessage(msg);
}

async function setupWebhook(webhookUrl){
  const res=await axios.post(`${TELEGRAM_API}/setWebhook`,{
    url:`${webhookUrl}/webhook/telegram`,allowed_updates:["message"],drop_pending_updates:false,
  });
  logger.info("Webhook set",{ok:res.data.ok});
}

const telegramService={
  processUpdate,setupWebhook,
  getCacheStats:()=>({images:imageCache.size,texts:textCache.size,replies:replyIndex.size}),
};

module.exports={searchInvoiceByAll,telegramService};
