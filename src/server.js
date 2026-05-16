"use strict";
require("dotenv").config();
const express  = require("express");
const axios    = require("axios");
const FormData = require("form-data");
const cors     = require("cors");
const helmet   = require("helmet");
const rateLimit = require("express-rate-limit");
const multer   = require("multer");
const { searchInvoiceByAll, telegramService, addRuntimeStatus, getDebugCache, addManualInvoice } = require("./telegram");
const { fetchDepositRemarkByUsername } = require("./boBrowser");
const { sendAndForward }               = require("./telegram");
const logger = require("./logger");

// ── Multer ────────────────────────────────────────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    file.mimetype.startsWith("image/") ? cb(null, true) : cb(new Error("Chỉ chấp nhận file ảnh"), false);
  },
});

// ── App ───────────────────────────────────────────────────────────────────────
const app  = express();
const PORT = process.env.PORT || 3000;

app.set("trust proxy", 1);
app.use(helmet());
app.use(cors({ origin: "*" }));
app.use(express.json({ limit: "20kb" }));
app.use("/webhook", rateLimit({ windowMs: 60000, max: 200, standardHeaders: true, legacyHeaders: false }));

// ── Logs ──────────────────────────────────────────────────────────────────────
const recentLogs = [];
const _origInfo  = logger.info.bind(logger);
const _origError = logger.error.bind(logger);
const _origWarn  = logger.warn.bind(logger);
function pushLog(level, msg, meta) {
  recentLogs.push({ ts: new Date().toISOString(), level, msg, meta: meta || {} });
  if (recentLogs.length > 100) recentLogs.shift();
}
logger.info  = (m, d) => { pushLog("info",  m, d); _origInfo(m,  d); };
logger.error = (m, d) => { pushLog("error", m, d); _origError(m, d); };
logger.warn  = (m, d) => { pushLog("warn",  m, d); _origWarn(m,  d); };

// ── Routes cơ bản ─────────────────────────────────────────────────────────────
app.get("/health", (_req, res) => res.json({
  status: "ok",
  timestamp: new Date().toISOString(),
}));

// ── Webhook Telegram ──────────────────────────────────────────────────────────
app.post("/webhook/telegram", async (req, res) => {
  try { await telegramService.processUpdate(req.body); } catch (e) { logger.error("TG error", { error: e.message }); }
  res.json({ ok: true });
});

// ── Public API — Web tool tra cứu ─────────────────────────────────────────────
const checkInvoiceLimit = rateLimit({
  windowMs: 60 * 1000, max: 20,
  message: { found: false, error: "Quá nhiều yêu cầu, vui lòng chờ 1 phút" },
  standardHeaders: true, legacyHeaders: false,
});

app.get("/api/check-invoice", (_req, res) => {
  const stats = telegramService.getCacheStats();
  res.json({ ok: true, cache: stats, message: "POST để tra cứu hóa đơn" });
});

app.post("/api/check-invoice", checkInvoiceLimit, upload.single("image"), async (req, res) => {
  const { username, transferContent } = req.body || {};
  const imageBuffer = req.file?.buffer || null;

  if (!username && !transferContent && !imageBuffer) {
    return res.status(400).json({ found: false, error: "Thiếu thông tin tra cứu" });
  }

  logger.info("Web check-invoice", { username: username || "-", ck: transferContent || "-", hasImage: !!imageBuffer });

  try {
    const result = await searchInvoiceByAll({
      username:        username        || null,
      fullname:        null,
      transferContent: transferContent || null,
      imageBuffer,
    });

    if (result?.found) {
      return res.json({
        found:    true,
        status:   result.status || "Đang xử lý",
        note:     result.note   || null,
        username: username      || null,
        ck:       transferContent || null,
      });
    }
    return res.json({ found: false });

  } catch (err) {
    logger.error("Web check-invoice error", { error: err.message });
    return res.json({ found: false, error: "Lỗi hệ thống, vui lòng thử lại" });
  }
});

// ── Public API — Hối thúc hóa đơn qua Telegram ────────────────────────────────
app.post("/api/urgent-invoice", upload.single("image"), async (req, res) => {
  try {
    const username        = (req.body.username        || "-").trim();
    const fullname        = (req.body.fullname         || "-").trim();
    const transferContent = (req.body.transferContent  || req.body.ck || "-").trim();
    const image           = req.file;

    if (!username || username === "-" || !transferContent || transferContent === "-") {
      return res.status(400).json({ ok: false, error: "Thiếu tài khoản hoặc mã giao dịch" });
    }

    // ── Tra thông tin hóa đơn từ BO ──────────────────────────────────────────────
    let remarks    = "-";
    let isApproved = false;
    try {
      const info = await fetchDepositRemarkByUsername(username);
      if (info) {
        remarks    = info.remarks    || "-";
        isApproved = info.isApproved || false;
        logger.info("BO deposit fetched", { username, remarks, isApproved });
      }
    } catch (e) {
      logger.warn("BO fetch skipped", { error: e.message });
    }

    // ── Nếu đã Approved → trả kết quả ngay ──────────────────────────────────────
    if (isApproved) {
      logger.info("Deposit approved, returning immediately", { username });
      return res.json({
        ok:       true,
        approved: true,
        message:  "Lệnh nạp của bạn đã được xử lý thành công! Vui lòng kiểm tra lại số dư tài khoản.",
      });
    }

    // ── Gửi vào Nhóm CSKH + forward sang Nhóm T3 kèm buttons ────────────────────
    await sendAndForward({
      username,
      fullname,
      ckCode:       transferContent,
      remarks,
      imageBuffer:  image?.buffer   || null,
      imageMimetype: image?.mimetype || "image/jpeg",
    });

    return res.json({ ok: true, telegram: true });

  } catch (err) {
    logger.error("Urgent invoice send failed", {
      error: err.message,
      tg:    err.response?.data || null,
    });
    return res.status(500).json({
      ok:     false,
      error:  "Gửi hối thúc thất bại",
      detail: err.response?.data?.description || err.message,
    });
  }
});

// ── Admin API ─────────────────────────────────────────────────────────────────
const ADMIN_KEY = process.env.ADMIN_API_KEY || "";

function adminAuth(req, res, next) {
  const key = req.headers["x-admin-key"] || req.query.key;
  if (!ADMIN_KEY) return res.status(503).json({ error: "ADMIN_API_KEY chưa được cấu hình" });
  if (key !== ADMIN_KEY) return res.status(401).json({ error: "Unauthorized" });
  next();
}

app.get("/admin/stats", adminAuth, (_req, res) => {
  res.json({
    ok:        true,
    cache:     telegramService.getCacheStats(),
    uptime:    Math.floor(process.uptime()),
    memory:    Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + "MB",
    timestamp: new Date().toISOString(),
  });
});

app.get("/admin/logs", adminAuth, (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  res.json({ ok: true, logs: recentLogs.slice(-limit) });
});

app.get("/admin/cache", adminAuth, (_req, res) => {
  res.json({ ok: true, cache: telegramService.getCacheStats() });
});

app.get("/admin/cache/inspect", adminAuth, (_req, res) => {
  const data = getDebugCache();
  res.json({ ok: true, ...data });
});

app.post("/admin/cache/warmup", adminAuth, async (req, res) => {
  res.json({ ok: true, message: "Đang warmup cache..." });
  try { await telegramService.warmupCache(process.env.PUBLIC_URL); }
  catch (e) { logger.error("Manual warmup failed", { error: e.message }); }
});

app.post("/admin/status/add", adminAuth, (req, res) => {
  const { kw, full, emoji } = req.body;
  if (!kw || !full) return res.status(400).json({ error: "Thiếu kw hoặc full" });
  addRuntimeStatus({ kw, full, emoji: emoji || "📋" });
  res.json({ ok: true, message: "Đã thêm: " + kw });
});

// ── Error handler ─────────────────────────────────────────────────────────────
app.use((err, _req, res, _next) => {
  logger.error("Unhandled", { error: err.message });
  res.status(500).json({ error: "Internal server error" });
});

// ── Start ─────────────────────────────────────────────────────────────────────
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
