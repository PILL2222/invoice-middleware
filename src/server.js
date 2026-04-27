/**
 * server.js v3.1 — Debug mode + fix LiveChat webhook payload format
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

app.set("trust proxy", 1);
app.use(helmet());
app.use(cors({ origin: "*" }));
app.use(express.json({ limit: "20kb" }));
app.use("/webhook", rateLimit({
  windowMs: 60000, max: 120,
  standardHeaders: true, legacyHeaders: false,
  skip: () => false,
}));

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
setInterval(() => { const now=Date.now(); for(const [id,s] of sessions) if(now-s.ts>SESSION_TTL) sessions.delete(id); }, 5*60*1000);

const seen = new Set();
setInterval(() => { if(seen.size>2000) seen.clear(); }, 10*60*1000);

// ── Helpers ───────────────────────────────────────────────────────────────────
function cleanUsername(v) { return v.replace(/[^a-zA-Z0-9@._\-]/g,"").slice(0,50); }
function cleanPhone(v) {
  const d = v.replace(/\D/g,"");
  return (d.startsWith("84") && d.length===11) ? "0"+d.slice(2) : d.slice(0,11);
}
function isValidPhone(v) { return /^0\d{9,10}$/.test(v); }
function isLikelyPhone(text) { return /^(\+?84|0)\d{8,10}$/.test(text.replace(/\s/g,"")); }
function isLikelyTransferContent(text) {
  return /^[A-Za-z0-9;._\-]{4,30}$/.test(text.trim()) && !isLikelyPhone(text);
}
function extractTransferContent(text) {
  if (!text) return null;
  const labeled = text.match(/(?:nội dung|nd|ck|content)[:\s]+([A-Za-z0-9;._\-]{4,50})/i);
  if (labeled) return labeled[1].trim();
  if (isLikelyTransferContent(text)) return text.trim();
  return null;
}
function isComplete(s) { return s.phone && s.imageUrl && s.transferContent; }
function statusReminder(s) {
  const m = [];
  if (!s.phone) m.push("📱 Số điện thoại đăng ký");
  if (!s.imageUrl) m.push("🖼️ Ảnh hóa đơn");
  if (!s.transferContent) m.push("🔑 Nội dung chuyển khoản (VD: CKFP5e0h)");
  return m.join("\n");
}

// ── Parse LiveChat webhook payload (hỗ trợ nhiều format) ─────────────────────
function parseLivechatPayload(body) {
  // Format mới từ Developer Console Chat Webhooks
  // { action: "incoming_event", payload: { chat_id, event: { text, author_id, type } } }
  // { action: "incoming_chat", payload: { chat: { id, users: [{type:"customer"}] } } }
  
  const action = body?.action || body?.event?.type || "";
  
  // Lấy chat_id
  const chatId = body?.payload?.chat_id 
    || body?.payload?.chat?.id 
    || body?.chat?.id 
    || body?.chat_id 
    || null;

  // Lấy text tin nhắn
  const text = (body?.payload?.event?.text 
    || body?.payload?.event?.message?.text
    || body?.event?.text 
    || body?.text 
    || "").trim();

  // Lấy image URL
  const imageUrl = body?.payload?.event?.url
    || body?.payload?.event?.file?.url
    || body?.event?.url
    || null;

  // Xác định author type
  // Trong format mới: kiểm tra author_id trong danh sách users
  let authorType = body?.event?.author_type || body?.author_type || null;
  
  if (!authorType) {
    const authorId = body?.payload?.event?.author_id || null;
    const users = body?.payload?.chat?.users || body?.additional_data?.chat?.users || [];
    if (authorId && users.length > 0) {
      const author = users.find(u => u.id === authorId);
      authorType = author?.type || "customer"; // default customer nếu không rõ
    } else if (action === "incoming_event") {
      // Nếu là incoming_event và có author_id → thường là từ customer
      authorType = "customer";
    } else {
      authorType = "customer";
    }
  }

  // Event type
  const eventType = action || body?.event?.type || "";

  return { chatId, text, imageUrl, authorType, eventType };
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
    
    // LOG TOÀN BỘ PAYLOAD để debug
    logger.info("WEBHOOK RECEIVED", { 
      body: JSON.stringify(body).slice(0, 500) 
    });

    // Dedup
    const eventId = body?.payload?.event?.id || body?.event?.id || body?.id;
    if (eventId) {
      if (seen.has(eventId)) return;
      seen.add(eventId);
    }

    const { chatId, text, imageUrl, authorType, eventType } = parseLivechatPayload(body);
    
    logger.info("PARSED", { chatId, text: text.slice(0,50), authorType, eventType, hasImage: !!imageUrl });

    if (!chatId) return;

    // ── Chat mới bắt đầu ──────────────────────────────────────────────────
    if (eventType === "incoming_chat" || eventType === "chat_started") {
      setSession(chatId, { step:"wait_username" });
      await sendLivechatMessage(chatId,
        "Dạ em chào anh/chị! 👋\n\n" +
        "Anh/chị vui lòng cho em biết tên đăng nhập trên trang của mình nhé ạ?"
      );
      return;
    }

    // Bỏ qua tin của agent/bot
    if (authorType === "agent" || authorType === "bot") return;

    let session = getSession(chatId);

    // Chưa có session → tự động bắt đầu
    if (!session) {
      setSession(chatId, { step:"wait_username" });
      session = getSession(chatId);
      await sendLivechatMessage(chatId,
        "Dạ em chào anh/chị! 👋\n\n" +
        "Anh/chị vui lòng cho em biết tên đăng nhập trên trang của mình nhé ạ?"
      );
      return;
    }

    // ── Bước 1: Nhận username ─────────────────────────────────────────────
    if (session.step === "wait_username") {
      if (!text) return;
      const username = cleanUsername(text);
      if (username.length < 2) {
        await sendLivechatMessage(chatId, "Dạ tên đăng nhập chưa hợp lệ, anh/chị nhập lại giúp em nhé ạ 🙏");
        return;
      }
      setSession(chatId, { ...session, step:"collecting", username });
      await sendLivechatMessage(chatId,
        `✅ Dạ em đã nhận tên đăng nhập: ${username}\n\n` +
        "Anh/chị cho em xin thêm 3 thông tin sau nhé ạ:\n\n" +
        "📱 Số điện thoại đăng ký trên trang\n" +
        "🖼️ Ảnh hóa đơn chuyển khoản\n" +
        "🔑 Nội dung chuyển khoản (VD: CKFP5e0h)\n\n" +
        "Anh/chị có thể gửi lần lượt hoặc cùng lúc đều được ạ!"
      );
      return;
    }

    // ── Bước 2: Thu thập SĐT + ảnh + nội dung CK ─────────────────────────
    if (session.step === "collecting") {
      let updated = false;

      // Nhận ảnh
      if (imageUrl && !session.imageUrl) {
        session = { ...session, imageUrl };
        updated = true;
        logger.info("Got image", { chatId });
      }

      // Nhận SĐT
      if (text && !session.phone && isLikelyPhone(text)) {
        const phone = cleanPhone(text);
        if (isValidPhone(phone)) {
          session = { ...session, phone };
          updated = true;
        } else {
          await sendLivechatMessage(chatId, "Dạ số điện thoại chưa đúng (cần 10 số bắt đầu bằng 0), anh/chị nhập lại nhé ạ 🙏");
          return;
        }
      }

      // Nhận nội dung CK
      if (text && !session.transferContent && !isLikelyPhone(text)) {
        const ck = extractTransferContent(text);
        if (ck) { session = { ...session, transferContent: ck }; updated = true; }
      }

      // Off-topic
      if (!updated && text && text.length > 60) {
        await sendLivechatMessage(chatId,
          "Dạ anh/chị giúp em cung cấp đúng theo yêu cầu để em hỗ trợ nhanh chóng nhé ạ! 🙏\n\n" +
          "Còn thiếu:\n" + statusReminder(session)
        );
        return;
      }

      if (updated) setSession(chatId, session);

      if (isComplete(session)) {
        setSession(chatId, { ...session, step:"processing" });
        await processLookup(chatId, session);
        return;
      }

      if (updated) {
        const reminder = statusReminder(session);
        if (reminder) {
          await sendLivechatMessage(chatId, "✅ Dạ em đã nhận! Còn thiếu:\n\n" + reminder);
        }
      }
      return;
    }

    if (session.step === "processing") {
      await sendLivechatMessage(chatId, "Dạ em đang tra cứu, anh/chị chờ chút nhé ạ 🔍");
    }

  } catch (err) {
    logger.error("Handler error", { error: err.message, stack: err.stack?.slice(0,200) });
  }
});

async function processLookup(chatId, session) {
  await sendLivechatMessage(chatId, "🔍 Dạ em đang đối soát thông tin hóa đơn, vui lòng chờ em chút ạ...");
  const imageBuf = await downloadImage(session.imageUrl, process.env.LIVECHAT_PAT);
  if (!imageBuf) {
    await sendLivechatMessage(chatId, "Dạ em không tải được ảnh, anh/chị gửi lại ảnh giúp em nhé ạ 🙏");
    setSession(chatId, { ...session, step:"collecting", imageUrl:null }); return;
  }
  let result;
  try {
    result = await searchInvoiceByAll({ username:session.username, phone:session.phone, transferContent:session.transferContent, imageBuffer:imageBuf });
  } catch(err) {
    logger.error("Search error",{error:err.message});
    await sendLivechatMessage(chatId,"Dạ hệ thống gặp sự cố, em chuyển anh/chị sang nhân viên hỗ trợ ngay ạ...");
    await transferToAgent(chatId,`Lỗi tra cứu — User:${session.username} SĐT:${session.phone} CK:${session.transferContent}`);
    clearSession(chatId); return;
  }
  if (result.found) {
    const em={"Đã nhận được":"✅","Chưa nhận được":"⏳","Đã thanh toán":"✅","Chờ thanh toán":"⏳","Đang xử lý":"🔄","Đã hủy":"❌","Hoàn tiền":"↩️","Lỗi thanh toán":"⚠️"}[result.status]||"📋";
    await sendLivechatMessage(chatId,
      `${em} Dạ em tra cứu được thông tin hóa đơn ạ!\n\n` +
      `💰 Trạng thái: ${result.status}\n` +
      (result.note?`📝 Ghi chú: ${result.note}\n`:"")+
      `\nAnh/chị cần hỗ trợ thêm gì không ạ? 😊`
    );
  } else {
    await sendLivechatMessage(chatId,
      "Dạ em không tìm thấy hóa đơn khớp với thông tin anh/chị cung cấp ạ 😔\n" +
      "Em đang kết nối nhân viên hỗ trợ cho anh/chị..."
    );
    await transferToAgent(chatId,`Không khớp HĐ — User:${session.username} SĐT:${session.phone} CK:${session.transferContent}`);
  }
  clearSession(chatId);
}

app.post("/webhook/telegram", async (req, res) => {
  try { await telegramService.processUpdate(req.body); res.json({ok:true}); }
  catch(err) { logger.error("TG error",{error:err.message}); res.json({ok:true}); }
});

app.use((err,_req,res,_next) => {
  logger.error("Unhandled",{error:err.message});
  res.status(500).json({error:"Internal server error"});
});

app.listen(PORT, () => logger.info(`Server running on port ${PORT}`));
module.exports = app;
