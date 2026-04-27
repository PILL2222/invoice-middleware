# LiveChat ↔ Telegram Invoice Middleware

Hệ thống trung gian tự động tra cứu hóa đơn từ nhóm Telegram, trả kết quả cho khách qua LiveChat bot.

## Cấu trúc thư mục

```
livechat-telegram-middleware/
├── src/
│   ├── server.js      ← Server chính, nhận webhook từ LiveChat
│   ├── telegram.js    ← Kết nối Telegram, xử lý reply chain
│   ├── livechat.js    ← Gửi tin & chuyển agent LiveChat
│   ├── auth.js        ← Xác thực webhook signature
│   └── logger.js      ← Ghi log hệ thống
├── config/
│   └── bot-flow.js    ← Cấu hình flow bot LiveChat (tham khảo)
├── .env.example       ← Template biến môi trường (copy → .env)
├── package.json       ← Dependencies
└── README.md
```

## Cài đặt nhanh

```bash
npm install
cp .env.example .env
# Điền đầy đủ .env
npm start
```

## Biến môi trường (.env)

| Biến | Lấy từ đâu |
|------|------------|
| TELEGRAM_BOT_TOKEN | @BotFather |
| TELEGRAM_GROUP_ID | @userinfobot trong nhóm (số âm) |
| LIVECHAT_ACCOUNT_ID | Email đăng nhập LiveChat |
| LIVECHAT_PAT | LiveChat Console → Your profile → PAT |
| LIVECHAT_AGENT_GROUP_ID | 0 (mặc định) |
| LIVECHAT_WEBHOOK_SECRET | Tự đặt chuỗi bí mật bất kỳ |
| PUBLIC_URL | URL server có HTTPS |
| PORT | 3000 |

## Format tin nhắn nhóm Telegram

**Tin gốc:**
```
HD-2024-001 | 0901234567 | Nguyễn Văn A | Chưa nhận được
```

**Cập nhật trạng thái:** Reply vào tin cũ, gõ trạng thái mới:
```
Đã nhận được ✅
```
Bot luôn lấy **reply mới nhất** trong chuỗi.

## Trạng thái được hỗ trợ

- Đã nhận được
- Chưa nhận được  
- Đã thanh toán
- Chờ thanh toán
- Đang xử lý
- Đã hủy
- Hoàn tiền
- Lỗi thanh toán

## Kiểm tra server

```bash
curl https://your-server.com/health
# {"status":"ok","timestamp":"..."}
```

## Đăng ký Telegram Webhook (chạy 1 lần)

```
https://api.telegram.org/botTOKEN/setWebhook?url=https://YOUR-URL/webhook/telegram
```

## Luồng hoạt động

```
Khách LiveChat
  → Bot hỏi 3 câu (ID / SĐT / Mã HĐ)
  → Middleware nhận webhook
  → Tra cứu nhóm Telegram (cache + reply chain)
  → Tìm thấy: trả trạng thái mới nhất
  → Không thấy: chuyển sang real agent
```
