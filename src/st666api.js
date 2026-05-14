"use strict";
/**
 * ST666 Internal API Client
 *
 * Base  : https://boapi.bo666st.com/vh7prod-ims/api/v1
 * Auth  : JWT Bearer — tự động login + refresh khi hết hạn
 * Dùng  : fetchOrderInfo(username, ckCode) → { depositId, thirdPartyCode, ... }
 *
 * Phát hiện từ Network tab:
 *   - Login payload : { userid, password }  (password là SHA1 hash)
 *   - Login path    : /login
 *   - Token header  : Authorization: Bearer <jwt>
 *
 * ENV cần thiết:
 *   ST666_API_BASE = https://boapi.bo666st.com/vh7prod-ims/api/v1
 *   ST666_BO_USER  = userid đăng nhập admin panel (vd: jason666)
 *   ST666_BO_PASS  = mật khẩu gốc (code tự SHA1 trước khi gửi)
 */

const axios  = require("axios");
const crypto = require("crypto");
const logger = require("./logger");

const BASE    = process.env.ST666_API_BASE || "https://boapi.bo666st.com/vh7prod-ims/api/v1";
const BO_USER = process.env.ST666_BO_USER;
const BO_PASS = process.env.ST666_BO_PASS;

// SHA1 hash password — đúng với format server yêu cầu
function sha1(str) {
  return crypto.createHash("sha1").update(str).digest("hex");
}

// ── Token cache ───────────────────────────────────────────────────────────────
let _token        = null;
let _tokenExpiry  = 0;

function parseJwtExpiry(jwt) {
  try {
    const payload = JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString());
    return payload.exp ? payload.exp * 1000 : Date.now() + 3_600_000;
  } catch { return Date.now() + 3_600_000; }
}

// ── Headers mặc định — bắt chước browser admin panel ─────────────────────────
function buildHeaders(token) {
  return {
    "Accept":           "*/*",
    "Accept-Language":  "en-US,en;q=0.9",
    "Origin":           "https://bo.bo666st.com",
    "Referer":          "https://bo.bo666st.com/",
    "X-Currency":       "VND2",
    "User-Agent":       "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",
    ...(token ? { "Authorization": token } : {}),
  };
}

// ── Login + lấy JWT ───────────────────────────────────────────────────────────
async function login() {
  if (!BO_USER || !BO_PASS) throw new Error("ST666_BO_USER / ST666_BO_PASS chưa được cấu hình");

  logger.info("ST666 login...");
  const res = await axios.post(
    `${BASE}/login`,
    {
      userid:   BO_USER,
      password: sha1(BO_PASS),   // server nhận SHA1 hash, không phải plain text
    },
    { headers: buildHeaders(null), timeout: 12_000 }
  );

  // Token có thể nằm trong body hoặc response header X-token-renew
  const data  = res.data;
  const token = data?.token
             || data?.accessToken
             || data?.access_token
             || data?.data?.token
             || data?.data?.accessToken
             || res.headers?.["x-token-renew"]
             || res.headers?.["authorization"];

  if (!token) throw new Error("Login OK nhưng không tìm thấy token. Response: " + JSON.stringify(data).slice(0, 200));

  _token       = token.startsWith("Bearer ") ? token : `Bearer ${token}`;
  _tokenExpiry = parseJwtExpiry(token);
  logger.info("ST666 login OK", { user: BO_USER, expiry: new Date(_tokenExpiry).toISOString() });
  return _token;
}

// Lấy token hợp lệ — tự refresh nếu sắp hết hạn (<60s)
async function getToken() {
  if (_token && Date.now() < _tokenExpiry - 60_000) return _token;
  return login();
}

// ── Normalize mã CK để so khớp ───────────────────────────────────────────────
function normCK(s) {
  return (s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

// ── Search deposits theo username + date range ────────────────────────────────
// Endpoint: GET /deposits/search?dateFrom=YYYY-MM-DD&dateTo=YYYY-MM-DD&...
async function searchDeposits(username, dayRange = 7) {
  const token = await getToken();

  const now      = Date.now();
  const dateFrom = new Date(now - dayRange * 86_400_000).toISOString().split("T")[0];
  const dateTo   = new Date(now + 86_400_000).toISOString().split("T")[0];

  const res = await axios.get(`${BASE}/deposits/search`, {
    params: {
      dateFrom,
      dateTo,
      playerid:   username,   // ← field name từ response ("playerid")
      statusType: "DEPOSIT_AUDIT",
      language:   1,
      getImage:   false,
    },
    headers:  buildHeaders(token),
    timeout:  12_000,
  });

  // API có thể trả về array trực tiếp hoặc wrapped trong data/list/items
  const raw = res.data;
  if (Array.isArray(raw))             return raw;
  if (Array.isArray(raw?.data))       return raw.data;
  if (Array.isArray(raw?.list))       return raw.list;
  if (Array.isArray(raw?.items))      return raw.items;
  if (Array.isArray(raw?.deposits))   return raw.deposits;
  return [];
}

// ── So khớp mã CK trong field remarks ────────────────────────────────────────
// remarks format: "THUYPAY2680002234086311 / THUYPAY2680002234086311"
function matchByCK(deposits, ckCode) {
  const search = normCK(ckCode);
  if (!search || search.length < 4) return null;

  return deposits.find(d => {
    // Thử remarks trước (chứa mã giao dịch T3)
    const remarks = normCK(d.remarks || "");
    if (remarks.includes(search) || search.includes(remarks.replace(/\/.*/g, "").trim())) return true;

    // Thử depositid (UUID)
    const did = normCK(d.depositid || "");
    if (did === search) return true;

    return false;
  }) || null;
}

// ── Public: tra cứu đầy đủ thông tin hóa đơn ─────────────────────────────────
async function fetchOrderInfo(username, ckCode) {
  if (!username || !ckCode) return null;

  try {
    const deposits = await searchDeposits(username);
    logger.info("ST666 search", { username, ck: ckCode, results: deposits.length });

    let match = matchByCK(deposits, ckCode);

    // Nếu không tìm thấy trong 7 ngày → thử mở rộng 30 ngày
    if (!match && deposits.length === 0) {
      const wider = await searchDeposits(username, 30);
      match = matchByCK(wider, ckCode);
    }

    if (!match) {
      logger.info("ST666 no match", { username, ck: ckCode });
      return null;
    }

    logger.info("ST666 match found", {
      depositId: match.depositid,
      t3code:    match.thirdpartypaymentcode,
    });

    return {
      depositId:          match.depositid,           // UUID — mã đơn nội bộ
      thirdPartyCode:     match.thirdpartypaymentcode || null, // "THUYPAY" → dùng để route nhóm T3
      remarks:            match.remarks || null,
      status:             match.status,              // số: 1=pending, 3=approved, ...
      depositamt:         match.depositamt,
      playerid:           match.playerid,
      firstname:          match.firstname || null,
      depositPaymentType: match.depositPaymentTypeEnum || null,
    };

  } catch (err) {
    logger.error("ST666 fetchOrderInfo error", { error: err.message, username });
    return null;
  }
}

// ── Export ────────────────────────────────────────────────────────────────────
module.exports = { fetchOrderInfo };
