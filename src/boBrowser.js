"use strict";

/**
 * BO Browser Automation — lấy Deposit Remark bằng Playwright
 *
 * ENV cần có:
 *   BO_LOGIN_URL  = https://bo.bo666st.com/login
 *   BO_DEPOSIT_URL= https://bo.bo666st.com/depositAudit
 *   BO_USERNAME   = invoice1
 *   BO_PASSWORD   = invoice1
 *   PLAYWRIGHT_BROWSERS_PATH = 0
 */

const { chromium } = require("playwright");
const logger = require("./logger");

const BO_LOGIN_URL   = process.env.BO_LOGIN_URL   || "https://bo.bo666st.com/login";
const BO_DEPOSIT_URL = process.env.BO_DEPOSIT_URL || "https://bo.bo666st.com/depositAudit";
const BO_USERNAME    = process.env.BO_USERNAME;
const BO_PASSWORD    = process.env.BO_PASSWORD;

// ── Reuse browser + session giữa các lần gọi ─────────────────────────────────
let _browser  = null;
let _context  = null;
let _loggedIn = false;

async function getBrowser() {
  if (_browser?.isConnected()) return _browser;

  _browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-blink-features=AutomationControlled",  // tránh bot detection
    ],
  });
  _context  = null;
  _loggedIn = false;
  return _browser;
}

async function getContext() {
  const browser = await getBrowser();
  if (_context) return _context;

  _context = await browser.newContext({
    viewport:   { width: 1920, height: 1080 },
    userAgent:  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",
  });
  return _context;
}

// ── Login 1 lần, reuse session ────────────────────────────────────────────────
async function ensureLoggedIn() {
  if (_loggedIn) return;

  const context = await getContext();
  const page    = await context.newPage();

  try {
    logger.info("BO browser login...");
    await page.goto(BO_LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });

    // React app cần thời gian hydrate — dùng state: visible + timeout 20s
    await page.waitForSelector("#userid",   { state: "visible", timeout: 20_000 });
    await page.waitForSelector("#password", { state: "visible", timeout: 5_000  });

    await page.fill("#userid",   BO_USERNAME);
    await page.fill("#password", BO_PASSWORD);

    await Promise.all([
      page.waitForURL(url => !url.toString().includes("/login"), { timeout: 20_000 }),
      page.click('button:has-text("Login")'),
    ]);

    _loggedIn = true;
    logger.info("BO browser login OK");
  } finally {
    await page.close().catch(() => {});
  }
}

// ── Lấy Deposit Remark theo username ─────────────────────────────────────────
async function fetchDepositRemarkByUsername(username) {
  if (!BO_USERNAME || !BO_PASSWORD) {
    throw new Error("BO_USERNAME / BO_PASSWORD chưa được cấu hình");
  }
  if (!username) return null;

  let page;
  try {
    await ensureLoggedIn();
    const context = await getContext();
    page = await context.newPage();

    // ── Intercept API response thay vì scrape DOM ─────────────────────────────
    let searchData = null;
    page.on("response", async (resp) => {
      try {
        if (resp.url().includes("/deposits/search") && resp.status() === 200) {
          searchData = await resp.json();
        }
      } catch {}
    });

    logger.info("BO browser goto depositAudit", { username });
    await page.goto(BO_DEPOSIT_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForTimeout(2_000);

    // ── Điền username vào ô search Player ID ──────────────────────────────────
    // Selector: input[placeholder="Please enter text"] — lấy cái cuối cùng
    const inputs = page.locator('input[placeholder="Please enter text"]');
    const count  = await inputs.count();
    if (!count) throw new Error("Không tìm thấy ô search Player ID");

    await inputs.nth(count - 1).fill(username);
    logger.info("BO browser search playerid", { username });

    // ── Bấm Search và chờ API response ───────────────────────────────────────
    const respPromise = page.waitForResponse(
      resp => resp.url().includes("/deposits/search") && resp.status() === 200,
      { timeout: 15_000 }
    ).catch(() => null);

    await page.click('button:has-text("Search")');
    await respPromise;
    await page.waitForTimeout(500);

    // ── Parse JSON từ API response ────────────────────────────────────────────
    if (searchData) {
      const list = Array.isArray(searchData)           ? searchData
                 : Array.isArray(searchData?.data)     ? searchData.data
                 : Array.isArray(searchData?.list)     ? searchData.list
                 : Array.isArray(searchData?.items)    ? searchData.items
                 : Array.isArray(searchData?.deposits) ? searchData.deposits
                 : [];

      if (list.length > 0) {
        // Ưu tiên đơn pending (status 1 hoặc 0), fallback lấy đơn mới nhất
        const match = list.find(d => d.status === 1 || d.status === 0) || list[0];
        const remark = match?.remarks || null;
        logger.info("BO browser deposit found", { username, remark, status: match?.status });
        return remark;
      }
    }

    logger.warn("BO browser deposit remark not found", { username });
    return null;

  } catch (err) {
    logger.error("BO browser fetchDepositRemark failed", {
      username,
      error: err.message,
    });
    // Reset session để lần sau login lại
    _loggedIn = false;
    _context  = null;
    return null;

  } finally {
    await page?.close().catch(() => {});
  }
}

module.exports = { fetchDepositRemarkByUsername };
