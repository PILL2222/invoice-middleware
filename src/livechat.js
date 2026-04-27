/**
 * LiveChat API v4 — auto assign bot before sending
 */
const axios = require("axios");
const logger = require("./logger");

const EMAIL = process.env.LIVECHAT_ACCOUNT_ID || "";
const PAT   = process.env.LIVECHAT_PAT || "";
const BOT_AGENT_ID = process.env.LIVECHAT_BOT_AGENT_ID || ""; // UUID của bot agent

const lcClient = axios.create({
  baseURL: "https://api.livechatinc.com/v3.5/agent/action",
  headers: {
    "Content-Type": "application/json",
    "Authorization": `Basic ${Buffer.from(`${EMAIL}:${PAT}`).toString("base64")}`,
  },
  timeout: 12000,
});

async function withRetry(fn, retries=3, delay=600) {
  for(let i=0;i<retries;i++){
    try { return await fn(); }
    catch(err){
      const status = err.response?.status;
      if(i===retries-1) throw err;
      if(status===401||status===403) throw err; // Auth errors không retry
      await new Promise(r=>setTimeout(r,delay*Math.pow(2,i)));
      logger.warn(`Retry ${i+2}`,{error:err.message,status});
    }
  }
}

// Assign bot vào chat trước khi gửi tin
async function assignBotToChat(chatId) {
  if (!BOT_AGENT_ID) return; // Bỏ qua nếu chưa set
  try {
    await lcClient.post("/assign_chat", {
      id: chatId,
      agent: { id: BOT_AGENT_ID },
    });
    logger.info("Bot assigned to chat", { chatId });
  } catch(err) {
    // Nếu đã assign rồi thì OK, bỏ qua lỗi
    logger.debug("Assign chat (may already be assigned)", { error: err.message });
  }
}

async function sendLivechatMessage(chatId, text) {
  try {
    // Thử assign bot vào chat trước
    await assignBotToChat(chatId);
    
    await withRetry(() => lcClient.post("/send_event", {
      chat_id: chatId,
      event: { type:"message", text, visibility:"all" },
    }));
    logger.info("Message sent", { chatId, textPreview: text.slice(0,40) });
  } catch(err) {
    logger.error("sendLivechatMessage failed", {
      chatId,
      status: err.response?.status,
      data: JSON.stringify(err.response?.data||{}).slice(0,200),
    });
  }
}

async function transferToAgent(chatId, internalNote="") {
  try {
    if(internalNote) {
      await lcClient.post("/send_event",{
        chat_id:chatId,
        event:{type:"message",text:`[BOT NOTE] ${internalNote}`,visibility:"agents"},
      }).catch(()=>{});
    }
    const groupId = parseInt(process.env.LIVECHAT_AGENT_GROUP_ID||"0");
    await withRetry(()=>lcClient.post("/transfer_chat",{
      id:chatId,
      target:{type:"group",ids:[groupId]},
    }));
    logger.info("Transferred to agent",{chatId});
  } catch(err) {
    logger.error("transferToAgent failed",{chatId,error:err.message});
    // Fallback: ít nhất gửi tin báo khách
    try {
      await lcClient.post("/send_event",{
        chat_id:chatId,
        event:{type:"message",text:"Vui lòng chờ, nhân viên sẽ hỗ trợ bạn ngay!",visibility:"all"},
      });
    } catch(e){}
  }
}

function isCustomerAuthor(authorId) {
  if(!authorId) return true;
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if(uuidPattern.test(authorId)) return true;
  if(authorId.includes("@")||authorId.toLowerCase().includes("gmail")) return false;
  return true;
}

module.exports = { sendLivechatMessage, transferToAgent, isCustomerAuthor };
