/**
 * LiveChat ↔ Telegram Invoice Middleware v3.0
 * 4 tiêu chí đối soát:
 *   1. Tên đăng nhập
 *   2. Số điện thoại
 *   3. Hình ảnh hóa đơn (pHash)
 *   4. Nội dung chuyển khoản (VD: CKFP5e0h)
 *
 * Flow:
 *   Bot chào → hỏi username → hỏi SĐT + ảnh + nội dung CK
 *   → khách gửi 3 thứ theo thứ tự bất kỳ → bot đối soát → trả kết quả
 */

require("dotenv").config();
const express   = require("express");
const cors      = require("cors");
const helmet    = require("helmet");
const rateLimit = require("express-rate-limit");
const { searchInvoiceByAll, telegramService } = require("./telegram");
const { sendLivechatMessage, transferToAgent } = require("./livechat");
const { downloadImage } = require("./imageMatch");
const logger = require("./logger");

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(helmet());
app.use(cors({ origin: process.env.ALLOWED_ORIGINS?.split(",") || "*" }));
app.use(express.json({ limit: "20kb" }));
app.use("/webhook", rateLimit({ windowMs:60000, max:120, standardHeaders:true, legacyHeaders:false }));

// ── Session ───────────────────────────────────────────────────────────────────
const sessions = new Map();
const SESSION_TTL = 15 * 60 * 1000;

function getSession(id) {
  const s = sessions.get(id);
  if (!s) return null;
  if (Date.now() - s.ts > SESSION_TTL) { sessions.delete(id); return null; }
  return s;
}
function setSession(id, data) { sessions.set(id, { ...data, ts: Date.now() }); }
function clearSession(id) { sessions.delete(id); }
setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) if (now - s.ts > SESSION_TTL) sessions.delete(id);
}, 5 * 60 * 1000);

// ── Dedup ─────────────────────────────────────────────────────────────────────
const seen = new Set();
setInterval(() => { if (seen.size > 2000) seen.clear(); }, 10 * 60 * 1000);

// ── Helpers ───────────────────────────────────────────────────────────────────
function cleanUsername(v) { return v.replace(/[^a-zA-Z0-9@._\-]/g,"").slice(0,50); }
function cleanPhone(v) {
  const d = v.replace(/\D/g,"");
  return (d.startsWith("84") && d.length===11) ? "0"+d.slice(2) : d.slice(0,11);
}
function isValidPhone(v) { return /^0\d{9,10}$/.test(v); }

// Nhận dạng nội dung CK: chuỗi chữ+số dài 6-20 ký tự (VD: CKFP5e0h, ACB123456)
function extractTransferContent(text) {
  if (!text) return null;
  // Ưu tiên: chuỗi sau "nội dung:", "nd:", "ck:", hoặc standalone
  const labeled = text.match(/(?:nội dung|nd|ck|content|ma giao dich)[:\s]+([A-Za-z0-9;._\-]{4,50})/i);
  if (labeled) return labeled[1].trim();
  // Standalone: chuỗi chữ+số không có khoảng trắng, dài 4-30 ký tự
  const standalone = text.match(/^([A-Za-z0-9;._\-]{4,30})$/);
  if (standalone) return standalone[1].trim();
  return null;
}

function isLikelyPhone(text) { return /^(\+?84|0)\d{8,10}$/.test(text.replace(/\s/g,"")); }
function isLikelyTransferContent(text) {
  return /^[A-Za-z0-9;._\-]{4,30}$/.test(text.trim()) && !isLikelyPhone(text);
}

function extractImageUrl(body) {
  const ev = body?.event || body;
  return ev?.url || null;
}

// Kiểm tra tin có liên quan đến bước đang chờ không
function isOffTopic(text, session) {
  if (!text || !session) return false;
  // Nếu đang chờ phone/image/CK mà khách gửi câu hỏi dài → off topic
  const step = session.step;
  if (step === "wait_username") return false; // Bất cứ thứ gì cũng là username
  if (step === "collecting") {
    // Tin dài > 60 ký tự và không phải phone, không phải CK → off topic
    if (text.length > 60 && !isLikelyPhone(text) && !isLikelyTransferContent(text)) return true;
  }
  return false;
}

// ── Kiểm tra đã đủ thông tin chưa ───────────────────────────────────────────
function isComplete(session) {
  return session.phone && session.imageUrl && session.transferContent;
}

// ── Health ────────────────────────────────────────────────────────────────────
app.get("/health", (_req, res) => {
  res.json({ status:"ok", timestamp:new Date().toISOString(), sessions:sessions.size });
});

// ── Webhook LiveChat ──────────────────────────────────────────────────────────
app.post("/webhook/livechat", async (req, res) => {
  res.json({ ok: true });
  try {
    const body = req.body;
    const eventId = body?.event?.id || body?.id;
    if (eventId) { if (seen.has(eventId)) return; seen.add(eventId); }

    const chatId      = body?.chat?.id || body?.chat_id;
    const authorType  = body?.event?.author_type || body?.author_type;
    const eventType   = body?.event?.type || body?.type;
    const text        = (body?.event?.text || body?.text || "").trim();
    const imageUrl    = extractImageUrl(body);

    if (!chatId) return;

    // ── Chat mới → bot chào ────────────────────────────────────────────────
    if (eventType === "chat_started" || eventType === "incoming_chat") {
      setSession(chatId, { step:"wait_username" });
      await sendLivechatMessage(chatId,
        "Dạ em chào anh/chị! 👋\n\n" +
        "Để em hỗ trợ tra cứu hóa đơn, anh/chị vui lòng cho em biết " +
        "tên đăng nhập trên trang của mình trước nhé ạ?"
      );
      return;
    }

    if (authorType !== "customer") return;

    let session = getSession(chatId);

    // Chưa có session → bắt đầu
    if (!session) {
      setSession(chatId, { step:"wait_username" });
      session = getSession(chatId);
      await sendLivechatMessage(chatId,
        "Dạ em chào anh/chị! 👋\n\n" +
        "Anh/chị vui lòng cho em biết tên đăng nhập trên trang của mình nhé ạ?"
      );
      return;
    }

    // ── Bước 1: Nhận tên đăng nhập ────────────────────────────────────────
    if (session.step === "wait_username") {
      if (!text) return;
      const username = cleanUsername(text);
      if (username.length < 2) {
        await sendLivechatMessage(chatId,
          "Dạ tên đăng nhập chưa hợp lệ, anh/chị nhập lại giúp em nhé ạ 🙏"
        );
        return;
      }
      setSession(chatId, { ...session, step:"collecting", username });
      await sendLivechatMessage(chatId,
        `✅ Dạ em đã nhận tên đăng nhập: *${username}*\n\n` +
        "Anh/chị cho em xin thêm 3 thông tin sau nhé ạ:\n\n" +
        "📱 *Số điện thoại* đăng ký trên trang\n" +
        "🖼️ *Ảnh hóa đơn* chuyển khoản\n" +
        "🔑 *Nội dung chuyển khoản* (VD: CKFP5e0h)\n\n" +
        "Anh/chị có thể gửi lần lượt hoặc cùng lúc đều được ạ!"
      );
      return;
    }

    // ── Bước 2: Thu thập SĐT + ảnh + nội dung CK (thứ tự bất kỳ) ─────────
    if (session.step === "collecting") {

      // Off-topic
      if (isOffTopic(text, session)) {
        await sendLivechatMessage(chatId,
          "Dạ anh/chị giúp em cung cấp đúng theo yêu cầu để em hỗ trợ nhanh chóng nhé ạ! 🙏\n\n" +
          statusReminder(session)
        );
        return;
      }

      let updated = false;

      // Nhận ảnh
      if (imageUrl && !session.imageUrl) {
        session = { ...session, imageUrl };
        updated = true;
        logger.info("Received image", { chatId });
      }

      // Nhận SĐT
      if (text && !session.phone && isLikelyPhone(text)) {
        const phone = cleanPhone(text);
        if (isValidPhone(phone)) {
          session = { ...session, phone };
          updated = true;
          logger.info("Received phone", { chatId, phone });
        } else {
          await sendLivechatMessage(chatId,
            "Dạ số điện thoại chưa đúng định dạng (10 số, bắt đầu bằng 0), " +
            "anh/chị nhập lại giúp em nhé ạ 🙏"
          );
          return;
        }
      }

      // Nhận nội dung CK
      if (text && !session.transferContent && !isLikelyPhone(text)) {
        const ck = extractTransferContent(text);
        if (ck) {
          session = { ...session, transferContent: ck };
          updated = true;
          logger.info("Received transfer content", { chatId, ck });
        }
      }

      if (updated) setSession(chatId, session);

      // Đủ hết → xử lý
      if (isComplete(session)) {
        setSession(chatId, { ...session, step:"processing" });
        await processLookup(chatId, session);
        return;
      }

      // Chưa đủ → nhắc những gì còn thiếu
      const reminder = statusReminder(session);
      if (reminder && updated) {
        await sendLivechatMessage(chatId,
          "✅ Dạ em đã nhận! Anh/chị cho em thêm:\n\n" + reminder
        );
      }
      return;
    }

    // Đang xử lý → không nhận thêm
    if (session.step === "processing") {
      await sendLivechatMessage(chatId, "Dạ em đang tra cứu, anh/chị chờ em chút nhé ạ 🔍");
    }

  } catch (err) {
    logger.error("Handler error", { error: err.message });
  }
});

// ── Nhắc những thông tin còn thiếu ───────────────────────────────────────────
function statusReminder(session) {
  const missing = [];
  if (!session.phone)           missing.push("📱 Số điện thoại đăng ký");
  if (!session.imageUrl)        missing.push("🖼️ Ảnh hóa đơn");
  if (!session.transferContent) missing.push("🔑 Nội dung chuyển khoản (VD: CKFP5e0h)");
  return missing.join("\n");
}

// ── Xử lý đối soát ───────────────────────────────────────────────────────────
async function processLookup(chatId, session) {
  await sendLivechatMessage(chatId,
    "🔍 Dạ em đang đối soát thông tin hóa đơn, vui lòng chờ em chút ạ..."
  );

  // Download ảnh từ LiveChat
  const imageBuf = await downloadImage(session.imageUrl, process.env.LIVECHAT_PAT);
  if (!imageBuf) {
    await sendLivechatMessage(chatId,
      "Dạ em không tải được ảnh hóa đơn, anh/chị thử gửi lại ảnh giúp em nhé ạ 🙏"
    );
    setSession(chatId, { ...session, step:"collecting", imageUrl:null });
    return;
  }

  // Đối soát tất cả tiêu chí
  let result;
  try {
    result = await searchInvoiceByAll({
      username:        session.username,
      phone:           session.phone,
      transferContent: session.transferContent,
      imageBuffer:     imageBuf,
    });
  } catch (err) {
    logger.error("Search error", { error: err.message });
    await sendLivechatMessage(chatId,
      "Dạ hệ thống đang gặp sự cố, em chuyển anh/chị sang nhân viên hỗ trợ ngay ạ..."
    );
    await transferToAgent(chatId,
      `Lỗi hệ thống — User: ${session.username} / SĐT: ${session.phone} / CK: ${session.transferContent}`
    );
    clearSession(chatId);
    return;
  }

  if (result.found) {
    const emoji = {
      "Đã nhận được":"✅","Chưa nhận được":"⏳","Đã thanh toán":"✅",
      "Chờ thanh toán":"⏳","Đang xử lý":"🔄","Đã hủy":"❌",
      "Hoàn tiền":"↩️","Lỗi thanh toán":"⚠️",
    }[result.status] || "📋";

    await sendLivechatMessage(chatId,
      `${emoji} Dạ em tra cứu được thông tin hóa đơn của anh/chị ạ!\n\n` +
      `💰 Trạng thái: *${result.status}*\n` +
      `🔑 Nội dung CK: ${session.transferContent}\n` +
      (result.note ? `📝 Ghi chú: ${result.note}\n` : "") +
      `\nAnh/chị cần hỗ trợ thêm gì không ạ? 😊`
    );
    logger.info("Match found", { username:session.username, status:result.status });
  } else {
    await sendLivechatMessage(chatId,
      "Dạ em đối soát không tìm thấy hóa đơn khớp với thông tin anh/chị cung cấp ạ 😔\n" +
      "Em đang kết nối anh/chị với nhân viên hỗ trợ để kiểm tra thủ công nhé ạ..."
    );
    await transferToAgent(chatId,
      `Không khớp HĐ — User: ${session.username} / SĐT: ${session.phone} / CK: ${session.transferContent}`
    );
    logger.info("No match → transferred", { username:session.username });
  }
  clearSession(chatId);
}

// ── Telegram Webhook ──────────────────────────────────────────────────────────
app.post("/webhook/telegram", async (req, res) => {
  try { await telegramService.processUpdate(req.body); res.json({ ok:true }); }
  catch(err) { logger.error("TG error",{error:err.message}); res.json({ ok:true }); }
});

app.use((err,_req,res,_next) => {
  logger.error("Unhandled",{error:err.message});
  res.status(500).json({error:"Internal server error"});
});

app.listen(PORT, () => logger.info(`Server running on port ${PORT}`));
module.exports = app;
