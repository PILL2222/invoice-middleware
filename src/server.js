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

function cleanUsername(v){return v.replace(/[^a-zA-Z0-9@._\-]/g,"").slice(0,50);}
function cleanPhone(v){const d=v.replace(/\D/g,"");return(d.startsWith("84")&&d.length===11)?"0"+d.slice(2):d.slice(0,11);}
function isValidPhone(v){return /^0\d{9,10}$/.test(v);}
function isLikelyPhone(t){return /^(\+?84|0)\d{8,10}$/.test(t.replace(/\s/g,""));}

function parseMultiInfo(text, session) {
  const result = {};
  const phoneMatch = text.match(/\b((?:0|\+84)\d{8,10})\b/);
  if(phoneMatch && !session.phone) {
    const phone = cleanPhone(phoneMatch[1]);
    if(isValidPhone(phone)) result.phone = phone;
  }
  const withoutPhone = text.replace(phoneMatch?.[0]||"","").trim();
  const ckMatch = withoutPhone.match(/\b([A-Za-z0-9]{4,20})\b/g);
  if(ckMatch && !session.transferContent) {
    const ck = ckMatch.find(c => /[A-Za-z]/.test(c) && /[0-9]/.test(c));
    if(ck) result.transferContent = ck;
  }
  return result;
}

function isComplete(s){return s.phone&&s.imageUrl&&s.transferContent;}
function statusReminder(s){
  const m=[];
  if(!s.phone) m.push("📱 Số điện thoại đăng ký");
  if(!s.imageUrl) m.push("🖼️ Ảnh hóa đơn");
  if(!s.transferContent) m.push("🔑 Nội dung chuyển khoản (VD: CKFP5e0h)");
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
      setSession(chatId,{step:"wait_issue"});
      session=getSession(chatId);
      await sendLivechatMessage(chatId,
        "Dạ chào mừng anh đến với ! 👋\n\n"+
        "Em là Tuyết Nhi, phụ trách kiểm tra hóa đơn nạp tiền của mình.\n\n"+
        "Anh vui lòng cho em biết vấn đề mình đang gặp phải là gì ạ?"
      );
      return;
    }

    // Bước 0: Chờ khách nói vấn đề → nhận dạng có liên quan hóa đơn không
    if(session.step==="wait_issue"){
      if(!text)return;

      // Keyword nhận dạng vấn đề liên quan hóa đơn / nạp tiền
      const INVOICE_KW = [
        // Có dấu
        "hóa đơn","nạp tiền","nạp","chưa lên điểm","chưa lên","chưa nhận được","chưa nhận",
        "không lên điểm","không lên","không nhận được","không nhận",
        "tiền","chuyển khoản","thanh toán","giao dịch","biến động số dư",
        "điểm","lệnh nạp","kiểm tra","tra cứu","tra soát",
        "ngân hàng","tài khoản","số dư","hoàn tiền","hoàn lại",
        "nạp thất bại","nạp lỗi","lỗi nạp","lỗi thanh toán",
        "chưa vào","không vào","chưa cộng","không cộng",
        "đã chuyển","đã nạp","đã thanh toán","đã chuyển khoản",
        "bill","receipt","biên lai","ảnh hóa đơn",
        "mã giao dịch","mã ck","mã chuyển khoản","nội dung chuyển khoản",
        "acb","vcb","vietcombank","techcombank","mbbank","tpbank",
        "momo","zalopay","vnpay","viettel money","banking",

        // Không dấu (viết tắt hoặc gõ nhanh)
        "hoa don","nap tien","nap","chua len diem","chua len","chua nhan",
        "khong len","khong nhan","tien","chuyen khoan","thanh toan",
        "giao dich","bien dong","diem","lenh nap","kiem tra",
        "tra cuu","tra soat","ngan hang","tai khoan","so du",
        "hoan tien","nap that bai","nap loi","loi nap",
        "chua vao","khong vao","chua cong","khong cong",
        "da chuyen","da nap","da thanh toan",
        "ma giao dich","ma ck","noi dung chuyen khoan",
        "deposit","payment","transfer","invoice","bank",
      ];
      const t = text.toLowerCase();
      const isInvoice = INVOICE_KW.some(kw => t.includes(kw));

      if(isInvoice){
        // Liên quan hóa đơn → tiếp tục flow
        setSession(chatId,{...session,step:"wait_username"});
        await sendLivechatMessage(chatId,
          "Dạ em đã nắm vấn đề của mình rồi ạ!\n\n"+
          "Mình cho em xin tên đăng nhập và thêm 3 thông tin sau nhé ạ:\n\n"+
          "📱 Số điện thoại đăng ký trên trang\n"+
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
        "📱 Số điện thoại đăng ký trên trang\n"+
        "🖼️ Ảnh hóa đơn chuyển khoản\n"+
        "🔑 Nội dung chuyển khoản\n\n"+
        "Anh có thể giúp em cung cấp từng thông tin để em dễ dàng hỗ trợ kiểm tra chính xác cho mình ạ"
      );
      return;
    }

    // Bước 2: thu thập
    if(session.step==="collecting"){
      let updated=false;
      if(imageUrl&&!session.imageUrl){session={...session,imageUrl};updated=true;logger.info("Got image",{chatId});}
      if(text){
        const multi=parseMultiInfo(text,session);
        if(multi.phone){session={...session,phone:multi.phone};updated=true;logger.info("Got phone",{phone:multi.phone});}
        if(multi.transferContent){session={...session,transferContent:multi.transferContent};updated=true;logger.info("Got CK",{ck:multi.transferContent});}
        if(!updated&&!imageUrl&&text.length>80){
          await sendLivechatMessage(chatId,"Dạ anh giúp em cung cấp đúng theo yêu cầu để em hỗ trợ nhanh chóng nhé ạ! 🙏\n\nCòn thiếu:\n"+statusReminder(session));
          return;
        }
      }
      if(updated)setSession(chatId,session);
      if(isComplete(session)){setSession(chatId,{...session,step:"processing"});await processLookup(chatId,session);return;}
      if(updated&&statusReminder(session)){
        await sendLivechatMessage(chatId,"✅ Dạ em đã nhận thông tin của mình! Hiện tại còn thiếu, mình cấp mốt giúp em ạ:\n\n"+statusReminder(session));
      }
      return;
    }
    if(session.step==="processing"){await sendLivechatMessage(chatId,"Dạ em đang tiến hàng tra soát ngay cho mình, anh giúp em thông cảm chờ chút nhé ạ 🔍");}
  }catch(err){logger.error("Handler error",{error:err.message,stack:err.stack?.slice(0,200)});}
});

async function processLookup(chatId,session){
  await sendLivechatMessage(chatId,"🔍 Dạ em đang đối soát thông tin hóa đơn, vui lòng chờ em chút ạ...");
  const imageBuf=await downloadImage(session.imageUrl,process.env.LIVECHAT_PAT);
  if(!imageBuf){
    await sendLivechatMessage(chatId,"Dạ em không tải được ảnh, anh gửi lại ảnh giúp em nhé ạ 🙏");
    setSession(chatId,{...session,step:"collecting",imageUrl:null});return;
  }
  let result;
  try{result=await searchInvoiceByAll({username:session.username,phone:session.phone,transferContent:session.transferContent,imageBuffer:imageBuf});}
  catch(err){
    logger.error("Search error",{error:err.message});
    await sendLivechatMessage(chatId,"Dạ hệ thống gặp sự cố, em chuyển anh sang nhân viên hỗ trợ ngay ạ...");
    await transferToAgent(chatId,`Lỗi — User:${session.username} SĐT:${session.phone} CK:${session.transferContent}`);
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
  } else {
    await sendLivechatMessage(chatId,"Dạ em không tìm thấy hóa đơn khớp với thông tin anh cung cấp ạ 😔\nĐang kết nối nhân viên hỗ trợ cho anh...");
    await transferToAgent(chatId,`Không khớp — User:${session.username} SĐT:${session.phone} CK:${session.transferContent}`);
    logger.info("Not found → transferred");
  }
  clearSession(chatId);
}

app.post("/webhook/telegram",async(req,res)=>{try{await telegramService.processUpdate(req.body);res.json({ok:true});}catch(err){logger.error("TG error",{error:err.message});res.json({ok:true});}});
app.use((err,_req,res,_next)=>{logger.error("Unhandled",{error:err.message});res.status(500).json({error:"Internal server error"});});
app.listen(PORT, async () => {
  logger.info(`Server running on port ${PORT}`);
  // Nạp cache ngay khi khởi động
  const PUBLIC_URL = process.env.PUBLIC_URL;
  if (PUBLIC_URL) {
    // Chờ 2 giây để server sẵn sàng trước
    setTimeout(() => {
      telegramService.warmupCache(PUBLIC_URL)
        .then(() => logger.info("Cache warmup complete"))
        .catch(e => logger.error("Cache warmup failed", { error: e.message }));
    }, 2000);
  } else {
    logger.warn("PUBLIC_URL not set, skipping cache warmup");
  }
});
module.exports=app;
