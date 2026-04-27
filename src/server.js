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

// Parse tin nhắn 1 dòng chứa cả SĐT + CK
function parseMultiInfo(text, session) {
  const result = {};
  // Tìm SĐT
  const phoneMatch = text.match(/\b((?:0|\+84)\d{8,10})\b/);
  if(phoneMatch && !session.phone) {
    const phone = cleanPhone(phoneMatch[1]);
    if(isValidPhone(phone)) result.phone = phone;
  }
  // Tìm CK code (sau khi loại SĐT)
  const withoutPhone = text.replace(phoneMatch?.[0]||"","").trim();
  const ckMatch = withoutPhone.match(/\b([A-Za-z0-9]{4,20})\b/g);
  if(ckMatch && !session.transferContent) {
    // Lấy cái có vẻ giống CK nhất (không phải số thuần túy)
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
      setSession(chatId,{step:"wait_username"});
      await sendLivechatMessage(chatId,"Dạ em chào anh/chị! 👋\n\nAnh/chị vui lòng cho em biết tên đăng nhập trên trang của mình nhé ạ?");
      return;
    }

    if(!isCustomerAuthor(authorId)){logger.info("Skip agent",{authorId});return;}

    let session=getSession(chatId);
    if(!session){
      setSession(chatId,{step:"wait_username"});
      session=getSession(chatId);
      await sendLivechatMessage(chatId,"Dạ em chào anh/chị! 👋\n\nAnh/chị vui lòng cho em biết tên đăng nhập trên trang của mình nhé ạ?");
      return;
    }

    // Bước 1: username
    if(session.step==="wait_username"){
      if(!text)return;
      const username=cleanUsername(text);
      if(username.length<2){await sendLivechatMessage(chatId,"Dạ tên đăng nhập chưa hợp lệ, anh/chị nhập lại giúp em nhé ạ 🙏");return;}
      setSession(chatId,{...session,step:"collecting",username});
      await sendLivechatMessage(chatId,
        `✅ Dạ em đã nhận tên đăng nhập: ${username}\n\n`+
        "Anh/chị cho em xin thêm 3 thông tin sau nhé ạ:\n\n"+
        "📱 Số điện thoại đăng ký trên trang\n"+
        "🖼️ Ảnh hóa đơn chuyển khoản\n"+
        "🔑 Nội dung chuyển khoản (VD: CKFP5e0h)\n\n"+
        "Anh/chị có thể gửi từng thứ riêng hoặc gộp SĐT + mã CK chung 1 tin đều được ạ!"
      );
      return;
    }

    // Bước 2: thu thập
    if(session.step==="collecting"){
      let updated=false;
      // Nhận ảnh
      if(imageUrl&&!session.imageUrl){session={...session,imageUrl};updated=true;logger.info("Got image",{chatId});}
      // Thử parse multi-info (SĐT + CK trong 1 tin)
      if(text){
        const multi=parseMultiInfo(text,session);
        if(multi.phone){session={...session,phone:multi.phone};updated=true;logger.info("Got phone",{phone:multi.phone});}
        if(multi.transferContent){session={...session,transferContent:multi.transferContent};updated=true;logger.info("Got CK",{ck:multi.transferContent});}
        // Nếu không parse được gì và tin dài → off-topic
        if(!updated&&!imageUrl&&text.length>80){
          await sendLivechatMessage(chatId,"Dạ anh/chị giúp em cung cấp đúng theo yêu cầu để em hỗ trợ nhanh chóng nhé ạ! 🙏\n\nCòn thiếu:\n"+statusReminder(session));
          return;
        }
      }
      if(updated)setSession(chatId,session);
      if(isComplete(session)){setSession(chatId,{...session,step:"processing"});await processLookup(chatId,session);return;}
      if(updated&&statusReminder(session)){
        await sendLivechatMessage(chatId,"✅ Dạ em đã nhận! Còn thiếu:\n\n"+statusReminder(session));
      }
      return;
    }
    if(session.step==="processing"){await sendLivechatMessage(chatId,"Dạ em đang tra cứu, anh/chị chờ chút nhé ạ 🔍");}
  }catch(err){logger.error("Handler error",{error:err.message,stack:err.stack?.slice(0,200)});}
});

async function processLookup(chatId,session){
  await sendLivechatMessage(chatId,"🔍 Dạ em đang đối soát thông tin hóa đơn, vui lòng chờ em chút ạ...");
  
  // Luôn fetch messages mới nhất trước khi tìm
  const{telegramService:ts}=require("./telegram");
  
  const imageBuf=await downloadImage(session.imageUrl,process.env.LIVECHAT_PAT);
  if(!imageBuf){
    await sendLivechatMessage(chatId,"Dạ em không tải được ảnh, anh/chị gửi lại ảnh giúp em nhé ạ 🙏");
    setSession(chatId,{...session,step:"collecting",imageUrl:null});return;
  }
  let result;
  try{result=await searchInvoiceByAll({username:session.username,phone:session.phone,transferContent:session.transferContent,imageBuffer:imageBuf});}
  catch(err){
    logger.error("Search error",{error:err.message});
    await sendLivechatMessage(chatId,"Dạ hệ thống gặp sự cố, em chuyển anh/chị sang nhân viên hỗ trợ ngay ạ...");
    await transferToAgent(chatId,`Lỗi — User:${session.username} SĐT:${session.phone} CK:${session.transferContent}`);
    clearSession(chatId);return;
  }
  if(result.found){
    const em={"Đã lên điểm":"✅","Chưa lên điểm":"⏳","Đã nhận được":"✅","Chưa nhận được":"⏳","Đã thanh toán":"✅","Chờ thanh toán":"⏳","Đang xử lý":"🔄","Thành công":"✅","Thất bại":"❌","Đã hủy":"❌","Hoàn tiền":"↩️","Lỗi thanh toán":"⚠️"}[result.status]||"📋";
    await sendLivechatMessage(chatId,`${em} Dạ em tra cứu được ạ!\n\n💰 Trạng thái: ${result.status}\n`+(result.note?`📝 Ghi chú: ${result.note}\n`:"")+`\nAnh/chị cần hỗ trợ thêm không ạ? 😊`);
    logger.info("Found",{status:result.status});
  } else {
    await sendLivechatMessage(chatId,"Dạ em không tìm thấy hóa đơn khớp với thông tin anh/chị cung cấp ạ 😔\nĐang kết nối nhân viên hỗ trợ cho anh/chị...");
    await transferToAgent(chatId,`Không khớp — User:${session.username} SĐT:${session.phone} CK:${session.transferContent}`);
    logger.info("Not found → transferred");
  }
  clearSession(chatId);
}

app.post("/webhook/telegram",async(req,res)=>{try{await telegramService.processUpdate(req.body);res.json({ok:true});}catch(err){logger.error("TG error",{error:err.message});res.json({ok:true});}});
app.use((err,_req,res,_next)=>{logger.error("Unhandled",{error:err.message});res.status(500).json({error:"Internal server error"});});
app.listen(PORT,()=>logger.info(`Server running on port ${PORT}`));
module.exports=app;
