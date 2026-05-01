require("dotenv").config();
const express   = require("express");
const cors      = require("cors");
const helmet    = require("helmet");
const rateLimit = require("express-rate-limit");
const { searchInvoiceByAll, telegramService } = require("./telegram");
const { sendLivechatMessage, transferToAgent, isCustomerAuthor } = require("./livechat");
const { downloadImage } = require("./imageMatch");
const logger = require("./logger");

const app  = express();
const PORT = process.env.PORT || 3000;

app.set("trust proxy", 1);
app.use(helmet());
app.use(cors({ origin: "*" }));
app.use(express.json({ limit: "20kb" }));
app.use("/webhook", rateLimit({ windowMs:60000, max:200, standardHeaders:true, legacyHeaders:false }));

const sessions = new Map();
const SESSION_TTL = 15 * 60 * 1000;
function getSession(id){const s=sessions.get(id);if(!s)return null;if(Date.now()-s.ts>SESSION_TTL){sessions.delete(id);return null;}return s;}
function setSession(id,data){sessions.set(id,{...data,ts:Date.now()});}
function clearSession(id){sessions.delete(id);}
setInterval(()=>{const now=Date.now();for(const[id,s]of sessions)if(now-s.ts>SESSION_TTL)sessions.delete(id);},5*60*1000);

const seen=new Set();
setInterval(()=>{if(seen.size>2000)seen.clear();},10*60*1000);

function cleanUsername(v){return v.trim().slice(0,100);} // Giữ nguyên, chỉ trim và giới hạn độ dài
function cleanPhone(v){const d=v.replace(/\D/g,"");return(d.startsWith("84")&&d.length===11)?"0"+d.slice(2):d.slice(0,11);}
function isValidPhone(v){return /^0\d{9,10}$/.test(v);}

/**
 * Extract thông tin từ BẤT KỲ dạng text nào
 * Thứ tự ưu tiên: fullname → CK code (tránh nhầm)
 */
// Đủ điều kiện tra cứu: bắt buộc phải có ẢNH + CK code
function isComplete(s){
  return !!(s.transferContent && s.imageUrl);
}

function statusReminder(s){
  const m=[];
  if(!s.fullname) m.push("👤 Họ tên chủ tài khoản");
  if(!s.imageUrl) m.push("🖼️ Ảnh hóa đơn");
  if(!s.transferContent) m.push("🔑 Nội dung chuyển khoản hoặc Mã giao dịch");
  return m.join("\n");
}

function parseLivechatPayload(body){
  const action  = body?.action||"";
  const chatId  = body?.payload?.chat_id||body?.payload?.chat?.id||body?.chat?.id||body?.chat_id||null;
  const text    = (body?.payload?.event?.text||body?.event?.text||body?.text||"").trim();
  const imageUrl= body?.payload?.event?.url||body?.payload?.event?.file?.url||body?.event?.url||null;
  const authorId= body?.payload?.event?.author_id||body?.event?.author_id||null;
  const eventType=action||body?.event?.type||"";
  return{chatId,text,imageUrl,authorId,eventType};
}

app.get("/health",(_req,res)=>res.json({status:"ok",timestamp:new Date().toISOString(),sessions:sessions.size}));

app.get("/debug/cache",(_req,res)=>{
  const stats=telegramService.getCacheStats();
  res.json({ok:true,stats});
});

app.post("/webhook/livechat",async(req,res)=>{
  res.json({ok:true});
  try{
    const body=req.body;
    const eventId=body?.payload?.event?.id||body?.event?.id||body?.id;
    if(eventId){if(seen.has(eventId))return;seen.add(eventId);}
    const{chatId,text,imageUrl,authorId,eventType}=parseLivechatPayload(body);
    logger.info("WEBHOOK",{chatId,text:text.slice(0,50),authorId,eventType,hasImage:!!imageUrl});
    if(!chatId)return;

    if(eventType==="incoming_chat"||eventType==="chat_started"){
      setSession(chatId,{step:"wait_issue"});
      await sendLivechatMessage(chatId,
        "Dạ chào mừng anh đến với ! 👋\n\n"+
        "Em là Tuyết Nhi, phụ trách kiểm tra hóa đơn nạp tiền của mình.\n\n"+
        "Anh vui lòng cho em biết vấn đề mình đang gặp phải là gì ạ?"
      );
      return;
    }

    if(!isCustomerAuthor(authorId)){logger.info("Skip agent",{authorId});return;}

    let session=getSession(chatId);
    if(!session){
      // Kiểm tra nếu tin đầu tiên đã chứa keyword hóa đơn → bỏ qua bước chào
      const tLow = text.toLowerCase();
      const hasInvoiceKW = isInvoiceRelated(text);
      if(hasInvoiceKW && text.length > 5){
        // Bỏ qua wait_issue, vào thẳng wait_username
        setSession(chatId,{step:"wait_username"});
        session=getSession(chatId);
        await sendLivechatMessage(chatId,
          "Dạ em hiểu rồi ạ! Để em hỗ trợ kiểm tra hóa đơn cho anh nhé!\n\n"+
          "Anh vui lòng cho em biết *tên đăng nhập* trên trang của mình ạ?"
        );
      } else {
        setSession(chatId,{step:"wait_issue"});
        session=getSession(chatId);
        await sendLivechatMessage(chatId,
          "Dạ chào mừng anh đến với ! 👋\n\n"+
          "Em là Tuyết Nhi, phụ trách kiểm tra hóa đơn nạp tiền của mình.\n\n"+
          "Anh vui lòng cho em biết vấn đề mình đang gặp phải là gì ạ?"
        );
      }
      return;
    }

    // Bước 0: Chờ khách nói vấn đề → nhận dạng có liên quan hóa đơn không
    if(session.step==="wait_issue"){
      if(!text)return;

      // Lời chào hoặc tin quá ngắn → hỏi lại vấn đề, không route
      const GREETINGS = ["alo","hello","hi","chào","xin chào","hey","oke","ok","có","dạ","ừ","vâng","cho hỏi","hỏi","test","ping"];
      const tLow = text.toLowerCase().trim();
      const isGreeting = GREETINGS.some(g => tLow === g || tLow === g+"!") || text.length <= 5;

      if(isGreeting){
        await sendLivechatMessage(chatId,
          "Dạ em chào anh! 😊\n\n"+
          "Anh vui lòng cho em biết vấn đề mình đang gặp phải là gì để em hỗ trợ nhanh chóng nhé ạ?"
        );
        return; // Giữ nguyên step wait_issue, chờ khách nói tiếp
      }

      // Keyword nhận dạng vấn đề liên quan hóa đơn / nạp tiền
      const isInvoice = isInvoiceRelated(text);

      if(isInvoice){
        // Liên quan hóa đơn → tiếp tục flow
        setSession(chatId,{...session,step:"wait_username"});
        await sendLivechatMessage(chatId,
          "Dạ em đã nắm vấn đề của mình rồi ạ!\n\n"+
          "Mình cho em xin tên đăng nhập và thêm 3 thông tin sau nhé ạ:\n\n"+
          "👤 Họ tên của chủ tài khoản\n"+
          "🖼️ Ảnh hóa đơn chuyển khoản\n"+
          "🔑 Nội dung chuyển khoản\n\n"+
          "Anh cung cấp từng thông tin giúp em để em kiểm tra chính xác cho mình nhé ạ 🙏"
        );
      } else {
        // Không liên quan hóa đơn → chuyển agent ngay
        await sendLivechatMessage(chatId,
          "Dạ em hiểu vấn đề của mình rồi ạ!\n\n"+
          "Vấn đề này nằm ngoài phạm vi em có thể hỗ trợ trực tiếp, "+
          "em sẽ kết nối mình với nhân viên phụ trách để được hỗ trợ tốt nhất nhé ạ\n\n"+
          "📲 https://t.me/st666cskh247 🙏"
        );
        await transferToAgent(chatId,
          `Khách cần hỗ trợ ngoài phạm vi bot — Vấn đề: "${text.slice(0,100)}"`
        );
        clearSession(chatId);
      }
      return;
    }

    // Bước 1: username
    if(session.step==="wait_username"){
      if(!text)return;
      const username=cleanUsername(text);
      if(username.length<2){await sendLivechatMessage(chatId,"Dạ tên đăng nhập mình cung cấp chưa chính xác, anh kiểm tra và cung cấp nhập lại giúp em nhé ạ 🙏");return;}
      setSession(chatId,{...session,step:"collecting",username});
      await sendLivechatMessage(chatId,
        `✅ Dạ em đã nhận tên đăng nhập: ${username}\n\n`+
        "Anh cho em xin thêm 3 thông tin sau nhé ạ:\n\n"+
        "👤 Họ tên của chủ tài khoản\n"+
        "🖼️ Ảnh hóa đơn chuyển khoản\n"+
        "🔑 Nội dung chuyển khoản (nếu có) hoặc Mã giao dịch trên hóa đơn\n\n"+
        "Anh có thể giúp em cung cấp từng thông tin để em dễ dàng hỗ trợ kiểm tra chính xác cho mình ạ"
      );
      return;
    }

    // Bước 2: Thu thập thông tin — dùng Claude để hiểu tự nhiên
    if(session.step==="collecting"){
      let updated = false;

      // Nhận ảnh
      if(imageUrl && !session.imageUrl){
        session = {...session, imageUrl};
        updated = true;
        logger.info("Got image", {chatId});
      }

      // Dùng Claude extract thông tin từ text
      if(text){
        const extracted = extractInfo(text, session);

        if(extracted.fullname && !session.fullname){
          session = {...session, fullname: extracted.fullname};
          updated = true;
          logger.info("Got fullname", {fullname: extracted.fullname});
        }
        if(extracted.transferContent && !session.transferContent){
          session = {...session, transferContent: extracted.transferContent};
          updated = true;
          logger.info("Got CK", {ck: extracted.transferContent});
        }

        // Khách hỏi/phàn nàn → nhắc lại còn thiếu gì
        if(!updated && !imageUrl && extracted.intent === "ask_status" || extracted.intent === "other"){
          const missing = statusReminder(session);
          if(missing){
            await sendLivechatMessage(chatId,
              "Dạ em đang hỗ trợ kiểm tra hóa đơn cho anh ạ! 😊\n\n"+
              "Anh giúp em bổ sung thêm thông tin còn thiếu nhé:\n\n"+missing
            );
          }
          return;
        }
      }

      if(updated) setSession(chatId, session);

      // Đủ → tra cứu
      if(isComplete(session)){
        setSession(chatId, {...session, step:"processing"});
        await processLookup(chatId, session);
        return;
      }

      // Chưa đủ → nhắc
      const missing = statusReminder(session);
      if(updated && missing){
        const received = [];
        if(session.fullname)        received.push("Họ tên ✓");
        if(session.imageUrl)        received.push("Ảnh HĐ ✓");
        if(session.transferContent) received.push("Mã CK ✓");
        const recStr = received.length ? " (đã có: "+received.join(", ")+")" : "";
        await sendLivechatMessage(chatId,
          "✅ Dạ em đã nhận"+recStr+"!\n\nAnh bổ sung thêm giúp em:\n\n"+missing
        );
      }
      return;
    }
    if(session.step==="processing"){await sendLivechatMessage(chatId,"Dạ em đang tiến hành tra soát ngay cho mình, anh giúp em thông cảm chờ chút nhé ạ 🔍");return;}

    // Bước 4: Đã trả kết quả — kiểm tra khách có muốn tra HĐ mới không
    if(session.step==="done"){
      const wantsNewCheck = imageUrl || isInvoiceRelated(text);

      if(wantsNewCheck){
        setSession(chatId,{step:"collecting", username:session.username});
        await sendLivechatMessage(chatId,
          "Dạ em tiếp nhận yêu cầu kiểm tra hóa đơn tiếp theo của mình!\n\n"+
          "Anh cung cấp lại đầy đủ 3 thông tin giúp em nhé ạ:\n\n"+
          "👤 Họ tên của chủ tài khoản\n"+
          "🖼️ Ảnh hóa đơn chuyển khoản\n"+
          "🔑 Nội dung chuyển khoản (nếu có) hoặc Mã giao dịch trên hóa đơn 🙏"
        );
      } else {
        await sendLivechatMessage(chatId,
          "Dạ em rất vui được tiếp nhận thông tin của mình! 😊\n\n"+
          "Để có hướng dẫn nhanh chóng, anh liên hệ telegram CSKH bên em để được tư vấn cụ thể hơn ạ\n\n"+
          "📲 https://t.me/st666cskh247"
        );
      }
      return;
    }

  }catch(err){logger.error("Handler error",{error:err.message,stack:err.stack?.slice(0,200)});}
});

async function processLookup(chatId,session){
  resetStatsIfNewDay();
  statsStore.total++;
  await sendLivechatMessage(chatId,"🔍 Dạ em đang đối soát thông tin hóa đơn, vui lòng chờ em chút ạ...");
  const imageBuf=await downloadImage(session.imageUrl,process.env.LIVECHAT_PAT);
  if(!imageBuf){
    await sendLivechatMessage(chatId,"Dạ em không tải được ảnh, anh gửi lại ảnh giúp em nhé ạ 🙏");
    setSession(chatId,{...session,step:"collecting",imageUrl:null});return;
  }
  let result;
  try{result=await searchInvoiceByAll({username:session.username,fullname:session.fullname,transferContent:session.transferContent,imageBuffer:imageBuf});}
  catch(err){
    logger.error("Search error",{error:err.message});
    await sendLivechatMessage(chatId,"Dạ hệ thống gặp sự cố, em chuyển anh sang nhân viên hỗ trợ ngay ạ...");
    await transferToAgent(chatId,`Lỗi — User:${session.username} Họ tên:${session.fullname} CK:${session.transferContent}`);
    clearSession(chatId);return;
  }
  if(result.found){
    const CSKH_TG = "https://t.me/st666cskh247";

    // ── Trạng thái cần link CSKH ──────────────────────────────────────────────
    // Phải khớp CHÍNH XÁC với chuỗi admin gõ trong caption nhóm Telegram
    const CSKH_STATUSES = [
      "Đã nhận được, anh giúp em click vào telegram CSKH để bên em tiện trao đổi và hỗ trợ lên điểm",
      "Chuyển sai ngân hàng nhận, anh giúp em click vào telegram CSKH để bên em tiện trao đổi biết thêm thông tin ạ",
    ];

    const emMap = {
      "Đã lên điểm":        "✅",
      "Chưa lên điểm":      "❌",
      "Chưa nhận được":     "❌",
      "Chờ xác nhận thông tin": "⏳",
      "Hóa đơn hoàn tiền":  "↩️",
      "Giao dịch chưa xác định": "⚠️",
      [CSKH_STATUSES[0]]:   "⏳",
      [CSKH_STATUSES[1]]:   "❌",
    };

    const em = emMap[result.status] || "📋";
    const needCskh = CSKH_STATUSES.includes(result.status);
    const cskhLine = needCskh ? `\n📲 Liên hệ CSKH Telegram: ${CSKH_TG}` : "";

    await sendLivechatMessage(chatId,
      `${em} Dạ em tra cứu được ạ!\n\n` +
      `💰 Trạng thái: ${result.status}\n` +
      (result.note ? `📝 Ghi chú: ${result.note}\n` : "") +
      cskhLine +
      `\n\nAnh cần em hỗ trợ thêm không ạ? 😊`
    );
    logger.info("Found",{status:result.status});
    statsStore.found++;
    setSession(chatId,{...session,step:"done"});
  } else {
    const retryCount = session.retryCount||0;
    if(retryCount < 1){
      statsStore.retry++;
      await sendLivechatMessage(chatId,
        "Dạ em không tìm thấy hóa đơn khớp với thông tin anh cung cấp ạ 😔\n\n"+
        "Mình kiểm tra kĩ lại giúp em và cung cấp hóa đơn chính xác ạ 🙏"
      );
      setSession(chatId,{
        step:"collecting",
        username:session.username,
        retryCount: retryCount+1,
      });
    } else {
      statsStore.transfer++;
      await sendLivechatMessage(chatId,
        "Dạ em cảm ơn anh đã cung cấp lại nhưng em đối chiếu với hệ thống vẫn không nhận thấy hóa đơn mình đã cung cấp cho bên em 😔\n\n"+
        "Anh vui lòng giúp em liên hệ telegram CSKH sau để được hỗ trợ cặn kẽ hơn ạ:\n\n"+
        "📲 https://t.me/st666cskh247 🙏"
      );
      clearSession(chatId);
    }
    logger.info("Not found",{retry:retryCount});
  }
}

app.post("/webhook/telegram",async(req,res)=>{try{await telegramService.processUpdate(req.body);res.json({ok:true});}catch(err){logger.error("TG error",{error:err.message});res.json({ok:true});}});

// ── ADMIN API ─────────────────────────────────────────────────────────────────
// Bảo vệ bằng ADMIN_API_KEY trong .env
const ADMIN_KEY = process.env.ADMIN_API_KEY || "";

function adminAuth(req, res, next) {
  const key = req.headers["x-admin-key"] || req.query.key;
  if (!ADMIN_KEY) { res.status(503).json({ error: "ADMIN_API_KEY chưa được cấu hình" }); return; }
  if (key !== ADMIN_KEY) { res.status(401).json({ error: "Unauthorized" }); return; }
  next();
}

// Stats thật
const statsStore = { total: 0, found: 0, retry: 0, transfer: 0, date: new Date().toDateString() };
function resetStatsIfNewDay() {
  const today = new Date().toDateString();
  if (statsStore.date !== today) {
    statsStore.total = 0; statsStore.found = 0;
    statsStore.retry = 0; statsStore.transfer = 0;
    statsStore.date = today;
  }
}
// Export để processLookup cập nhật
global.botStats = statsStore;
global.resetStatsIfNewDay = resetStatsIfNewDay;

// In-memory logs (100 dòng gần nhất)
const recentLogs = [];
const origLog = logger.info.bind(logger);
const origErr = logger.error.bind(logger);
const origWarn = logger.warn.bind(logger);
function pushLog(level, msg, meta) {
  recentLogs.push({ ts: new Date().toISOString(), level, msg, meta: meta||{} });
  if (recentLogs.length > 100) recentLogs.shift();
}
logger.info  = (m,d) => { pushLog("info", m, d);  origLog(m, d); };
logger.error = (m,d) => { pushLog("error", m, d); origErr(m, d); };
logger.warn  = (m,d) => { pushLog("warn", m, d);  origWarn(m, d); };

// GET /admin/stats
app.get("/admin/stats", adminAuth, (req, res) => {
  resetStatsIfNewDay();
  const cacheStats = telegramService.getCacheStats();
  res.json({
    ok: true,
    stats: { ...statsStore },
    cache: cacheStats,
    sessions: sessions.size,
    uptime: Math.floor(process.uptime()),
    memory: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + "MB",
    timestamp: new Date().toISOString(),
  });
});

// GET /admin/logs
app.get("/admin/logs", adminAuth, (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  res.json({ ok: true, logs: recentLogs.slice(-limit) });
});

// GET /admin/cache
app.get("/admin/cache", adminAuth, (req, res) => {
  const stats = telegramService.getCacheStats();
  res.json({ ok: true, cache: stats, sessions: sessions.size });
});

// POST /admin/status/add — thêm trạng thái mới vào runtime
app.post("/admin/status/add", adminAuth, (req, res) => {
  const { kw, full, emoji } = req.body;
  if (!kw || !full) { res.status(400).json({ error: "Thiếu kw hoặc full" }); return; }
  const { addRuntimeStatus } = require("./telegram");
  if (typeof addRuntimeStatus === "function") {
    addRuntimeStatus({ kw: kw.toLowerCase(), full, emoji: emoji || "📋" });
    logger.info("Admin added status", { kw, full });
    res.json({ ok: true, message: "Đã thêm trạng thái: " + kw });
  } else {
    res.json({ ok: true, message: "Trạng thái đã nhận — restart server để áp dụng vĩnh viễn" });
  }
});

// POST /admin/cache/warmup — warmup cache thủ công
app.post("/admin/cache/warmup", adminAuth, async (req, res) => {
  res.json({ ok: true, message: "Đang warmup cache..." });
  try {
    await telegramService.warmupCache(process.env.PUBLIC_URL);
    logger.info("Manual cache warmup complete");
  } catch(e) { logger.error("Manual warmup failed", { error: e.message }); }
});

app.use((err,_req,res,_next)=>{logger.error("Unhandled",{error:err.message});res.status(500).json({error:"Internal server error"});});
app.listen(PORT, async () => {
  logger.info(`Server running on port ${PORT}`);
  const PUBLIC_URL = process.env.PUBLIC_URL;
  if (PUBLIC_URL) {
    setTimeout(() => {
      telegramService.warmupCache(PUBLIC_URL)
        .then(() => logger.info("Cache warmup complete"))
        .catch(e => logger.error("Cache warmup failed", { error: e.message }));
    }, 2000);
  } else {
    logger.warn("PUBLIC_URL not set, skipping cache warmup");
  }
});
module.exports = app;

