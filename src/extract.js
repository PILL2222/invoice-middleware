/**
 * extract.js — Dùng Claude API để hiểu tin nhắn khách
 * Thay thế toàn bộ rule-based parsing
 */

const axios = require("axios");
const logger = require("./logger");

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";

/**
 * Gọi Claude để extract thông tin từ tin nhắn khách
 * @param {string} text - Tin nhắn của khách
 * @param {object} session - Session hiện tại (biết đã có gì rồi)
 * @returns {{ fullname, transferContent, intent }}
 */
async function extractInfo(text, session) {
  if (!text || !ANTHROPIC_API_KEY) return {};

  // Tóm tắt những gì đã có
  const alreadyHave = [];
  if (session.username)        alreadyHave.push(`tên đăng nhập: ${session.username}`);
  if (session.fullname)        alreadyHave.push(`họ tên: ${session.fullname}`);
  if (session.transferContent) alreadyHave.push(`mã CK/GD: ${session.transferContent}`);
  if (session.imageUrl)        alreadyHave.push(`ảnh hóa đơn: đã có`);

  const prompt = `Bạn là trợ lý phân tích tin nhắn khách hàng của website cờ bạc trực tuyến.
Khách đang cung cấp thông tin để kiểm tra hóa đơn nạp tiền.

Thông tin đã thu thập được: ${alreadyHave.length ? alreadyHave.join(", ") : "chưa có gì"}

Tin nhắn khách vừa gửi: "${text}"

Hãy phân tích và trả về JSON với các trường sau (null nếu không có):
- fullname: Họ tên thật của khách (chuỗi chữ thuần, KHÔNG có số, ít nhất 2 từ). VD: "Nguyễn Văn A", "Le Thi My Hanh"
- transferContent: Mã chuyển khoản hoặc mã giao dịch (có thể chữ+số hoặc số thuần >= 6 ký tự). VD: "CKFP5e0h", "7HF54M4B", "126947749984"
- intent: Ý định của khách — một trong: "provide_info" (cung cấp thông tin), "ask_status" (hỏi trạng thái), "complain" (phàn nàn/hỏi thêm), "greeting" (chào hỏi), "other"

Lưu ý quan trọng:
- "len123123", "user123", "myhanh1234" là TÊN ĐĂNG NHẬP, KHÔNG phải họ tên và KHÔNG phải mã CK
- Họ tên phải là chữ thuần, có thể có dấu tiếng Việt, KHÔNG có số
- Mã CK thường là chuỗi ngẫu nhiên chữ+số hoặc số dài
- Nếu không chắc → để null, đừng đoán mò

Chỉ trả về JSON thuần, không giải thích:`;

  try {
    const res = await axios.post("https://api.anthropic.com/v1/messages", {
      model: "claude-haiku-4-5",
      max_tokens: 200,
      messages: [{ role: "user", content: prompt }],
    }, {
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      timeout: 8000,
    });

    const raw = res.data.content?.[0]?.text || "";
    const clean = raw.replace(/```json|```/g,"").trim();
    const parsed = JSON.parse(clean);

    logger.info("Claude extract", {
      text: text.slice(0,50),
      result: JSON.stringify(parsed).slice(0,100)
    });

    return {
      fullname:        parsed.fullname        || null,
      transferContent: parsed.transferContent || null,
      intent:          parsed.intent          || "other",
    };
  } catch(e) {
    logger.error("Claude extract error", { error: e.message });
    return {}; // fallback: trả về rỗng, không crash
  }
}

/**
 * Kiểm tra ý định có liên quan đến hóa đơn không
 */
function isInvoiceRelated(text) {
  const INVOICE_KW = [
    "hóa đơn","nạp tiền","nạp","chưa lên","chưa nhận","không lên","không nhận",
    "tiền","chuyển khoản","thanh toán","giao dịch","điểm","ngân hàng",
    "kiểm tra","tra cứu","tra soát","lệnh","mã ck","mã gd","bill","biên lai",
    "hoa don","nap tien","chua len","chua nhan","khong len","chuyen khoan",
    "giao dich","kiem tra","tra cuu","ngan hang","ma ck",
    "deposit","payment","transfer","invoice","bank","acb","vcb","mbbank","momo","zalopay",
  ];
  const t = text.toLowerCase();
  return INVOICE_KW.some(kw => t.includes(kw));
}

module.exports = { extractInfo, isInvoiceRelated };
