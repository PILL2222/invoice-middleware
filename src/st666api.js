"use strict";
/**
 * ST666 Internal API Client
 *
 * Mục tiêu:
 * - Không dùng mã CK để match mã đơn nội bộ.
 * - Chỉ tra theo username trên BO.
 * - Lấy field remarks / Deposit Remark của deposit mới nhất.
 * - Dùng Deposit Remark làm dòng 4 trong caption Telegram.
 */

const axios  = require("axios");
const crypto = require("crypto");
const logger = require("./logger");

const BASE    = process.env.ST666_API_BASE || "https://boapi.bo666st.com/vh7prod-ims/api/v1";
const BO_USER = process.env.ST666_BO_USER;
const BO_PASS = process.env.ST666_BO_PASS;

function sha1(str) {
  return crypto.createHash("sha1").update(str).digest("hex");
}

let _token       = null;
let _tokenExpiry = 0;

function parseJwtExpiry(jwt) {
  try {
    const raw = jwt.replace(/^Bearer\s+/i, "");
    const payload = JSON.parse(Buffer.from(raw.split(".")[1], "base64url").toString());
    return payload.exp ? payload.exp * 1000 : Date.now() + 3600000;
  } catch {
    return Date.now() + 3600000;
  }
}

function buildHeaders(token) {
  return {
    "Accept": "*/*",
    "Accept-Language": "en-US,en;q=0.9",
    "Origin": "https://bo.bo666st.com",
    "Referer": "https://bo.bo666st.com/",
    "X-Currency": "VND2",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",
    ...(token ? { "Authorization": token } : {}),
  };
}

async function login() {
  if (!BO_USER || !BO_PASS) {
    throw new Error("ST666_BO_USER / ST666_BO_PASS chưa được cấu hình");
  }

  logger.info("ST666 login...");
  const res = await axios.post(
    `${BASE}/login`,
    {
      userid: BO_USER,
      password: sha1(BO_PASS),
    },
    {
      headers: buildHeaders(null),
      timeout: 12000,
    }
  );

  const data = res.data;
  const token = data?.token
             || data?.accessToken
             || data?.access_token
             || data?.data?.token
             || data?.data?.accessToken
             || res.headers?.["x-token-renew"]
             || res.headers?.["authorization"];

  if (!token) {
    throw new Error("Login OK nhưng không tìm thấy token. Response: " + JSON.stringify(data).slice(0, 200));
  }

  _token = token.startsWith("Bearer ") ? token : `Bearer ${token}`;
  _tokenExpiry = parseJwtExpiry(_token);

  logger.info("ST666 login OK", {
    user: BO_USER,
    expiry: new Date(_tokenExpiry).toISOString(),
  });

  return _token;
}

async function getToken() {
  if (_token && Date.now() < _tokenExpiry - 60000) return _token;
  return login();
}

async function searchDeposits(username, dayRange = 7) {
  const token = await getToken();

  const now = Date.now();
  const dateFrom = new Date(now - dayRange * 86400000).toISOString().split("T")[0];
  const dateTo = new Date(now + 86400000).toISOString().split("T")[0];

  const res = await axios.get(`${BASE}/deposits/search`, {
    params: {
      dateFrom,
      dateTo,
      playerid: username,
      statusType: "DEPOSIT_AUDIT",
      language: 1,
      getImage: false,
    },
    headers: buildHeaders(token),
    timeout: 12000,
  });

  const raw = res.data;
  if (Array.isArray(raw)) return raw;
  if (Array.isArray(raw?.data)) return raw.data;
  if (Array.isArray(raw?.list)) return raw.list;
  if (Array.isArray(raw?.items)) return raw.items;
  if (Array.isArray(raw?.deposits)) return raw.deposits;

  return [];
}

function getDepositTime(d) {
  const candidates = [
    d.createdate,
    d.createDate,
    d.createdAt,
    d.createTime,
    d.depositdate,
    d.depositDate,
    d.deposittime,
    d.depositTime,
    d.applytime,
    d.applyTime,
    d.updatedate,
    d.updateDate,
  ];

  for (const v of candidates) {
    if (!v) continue;
    const t = new Date(v).getTime();
    if (!Number.isNaN(t)) return t;
  }

  return 0;
}

function pickLatestDeposit(deposits) {
  if (!Array.isArray(deposits) || deposits.length === 0) return null;
  return deposits
    .filter(Boolean)
    .sort((a, b) => getDepositTime(b) - getDepositTime(a))[0] || deposits[0];
}

function extractDepositRemark(deposit) {
  if (!deposit) return null;

  return deposit.remarks
      || deposit.remark
      || deposit.depositRemark
      || deposit.depositremark
      || deposit.deposit_remarks
      || deposit.depositremarks
      || deposit.depositRemarkText
      || null;
}

// Public: tra username trên BO và lấy Deposit Remark của deposit mới nhất
async function fetchOrderInfo(username) {
  if (!username) return null;

  try {
    let deposits = await searchDeposits(username, 7);

    if (!deposits.length) {
      deposits = await searchDeposits(username, 30);
    }

    logger.info("ST666 deposit search by username", {
      username,
      results: deposits.length,
    });

    const latest = pickLatestDeposit(deposits);

    if (!latest) {
      logger.info("ST666 no deposit found by username", { username });
      return null;
    }

    const depositRemark = extractDepositRemark(latest);

    logger.info("ST666 latest deposit found", {
      username,
      depositId: latest.depositid || null,
      depositRemark,
    });

    return {
      depositId: latest.depositid || null,
      depositRemark: depositRemark || null,
      remarks: depositRemark || null,
      thirdPartyCode: latest.thirdpartypaymentcode || null,
      status: latest.status,
      depositamt: latest.depositamt,
      playerid: latest.playerid,
      firstname: latest.firstname || null,
      depositPaymentType: latest.depositPaymentTypeEnum || null,
    };

  } catch (err) {
    logger.error("ST666 fetchOrderInfo error", {
      error: err.message,
      username,
    });
    return null;
  }
}

module.exports = { fetchOrderInfo };
