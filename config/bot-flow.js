/**
 * LiveChat Bot Configuration
 * 
 * This file defines the bot flow that:
 * 1. Greets customer
 * 2. Collects ID, phone, invoice_id via quick replies
 * 3. Calls middleware webhook with collected data
 * 
 * Deploy this in LiveChat's Bot section (ChatBot or Engagement).
 * The bot uses "Collect customer data" blocks, then calls a webhook.
 */

module.exports = {
  bot_name: "Hỗ trợ Hóa đơn",
  triggers: [
    // Trigger bot when customer selects "Kiểm tra hóa đơn" or types keywords
    { type: "intent", value: "invoice_inquiry" },
    { type: "keyword", values: ["hóa đơn", "invoice", "kiểm tra hd", "tình trạng hd"] },
  ],

  flow: [
    {
      id: "step_1_greeting",
      type: "message",
      text: "Xin chào! Tôi sẽ giúp bạn tra cứu tình trạng hóa đơn.\nVui lòng cung cấp thông tin sau:",
    },
    {
      id: "step_2_collect_customer_id",
      type: "collect",
      question: "1️⃣ Mã khách hàng (ID) của bạn là gì?",
      variable: "customer_id",
      validation: {
        type: "regex",
        pattern: "^[A-Za-z0-9\\-_]{3,50}$",
        error_message: "Mã khách hàng không hợp lệ. Vui lòng nhập lại.",
      },
    },
    {
      id: "step_3_collect_phone",
      type: "collect",
      question: "2️⃣ Số điện thoại đăng ký tài khoản:",
      variable: "phone",
      validation: {
        type: "regex",
        pattern: "^(0|\\+84)[0-9]{9,10}$",
        error_message: "Số điện thoại không hợp lệ. Vui lòng nhập số 10-11 chữ số.",
      },
    },
    {
      id: "step_4_collect_invoice",
      type: "collect",
      question: "3️⃣ Mã hóa đơn cần tra cứu:",
      variable: "invoice_id",
      validation: {
        type: "regex",
        pattern: "^[A-Za-z0-9\\-_]{3,50}$",
        error_message: "Mã hóa đơn không hợp lệ. Vui lòng nhập lại.",
      },
    },
    {
      id: "step_5_confirm",
      type: "message",
      text: "🔍 Đang tra cứu hóa đơn **{{invoice_id}}** cho SĐT **{{phone}}**...",
    },
    {
      id: "step_6_webhook",
      type: "webhook",
      url: "${process.env.PUBLIC_URL}/webhook/livechat",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-LiveChat-Signature": "{{hmac_signature}}",
      },
      body: {
        chat_id: "{{chat_id}}",
        customer_id: "{{customer_id}}",
        phone: "{{phone}}",
        invoice_id: "{{invoice_id}}",
      },
      timeout_ms: 8000,
      on_timeout: {
        type: "transfer",
        message: "Hệ thống tra cứu đang chậm, chuyển sang nhân viên hỗ trợ...",
      },
    },
  ],
};
