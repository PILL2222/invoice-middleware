"use strict";

/**
 * BO Browser Automation — lấy Deposit Remark bằng Playwright + Stealth
 *
 * ENV cần có:
 *   BO_LOGIN_URL   = https://bo.bo666st.com/login
 *   BO_DEPOSIT_URL = https://bo.bo666st.com/depositAudit
 *   BO_USERNAME    = invoice1
 *   BO_PASSWORD    = invoice1
 *   PLAYWRIGHT_BROWSERS_PATH = 0
 *
 * Cần cài thêm:
 *   npm install playwright-extra puppeteer-extra-plugin-stealth
 */

const { chromium } = require("playwright-extra");
const stealth      = require("puppeteer-extra-plugin-stealth")();
chromium.use(stealth);

const logger = require("./logger");

const BO_LOGIN_URL   = process.env.BO_LOGIN_URL   || "https://bo.bo666st.com/login";
const BO_DEPOSIT_URL = process.env.BO_DEPOSIT_URL || "https://bo.bo666st.com/depositAudit";
const BO_USERNAME    = process.env.BO_USERNAME;
const BO_PASSWORD    = process.env.BO_PASSWORD;

// ── Reuse browser + session ───────────────────────────────────────────────────
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
    ],
  });
  _context  = null;
  _loggedIn = false;
  return _browser;
}

async function getContext() {
  await getBrowser();
  if (_context) return _context;

  _context = await _browser.newContext({
    viewport:  { width: 1920, height: 1080 },
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",
    locale:    "en-US",
  });

  // Ẩn thêm dấu hiệu automation
  await _context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver",  { get: () => false });
    Object.defineProperty(navigator, "plugins",    { get: () => [1, 2, 3] });
    Object.defineProperty(navigator, "languages",  { get: () => ["en-US", "en"] });
    window.chrome = { runtime: {} };
  });

  return _context;
}

async function ensureLoggedIn() {
  if (_loggedIn) return;

  const context = await getContext();
  const page    = await context.newPage();

  try {
    logger.info("BO browser login...");
    await page.goto(BO_LOGIN_URL, { waitUntil: "networkidle", timeout: 30_000 });

    // Log URL + title để debug
    const url   = page.url();
    const title = await page.title();
    logger.info("BO login page loaded", { url, title });

    // Thử nhiều selector, dùng cái nào visible trước trong 45s
    const userInput = await Promise.race([
      page.waitForSelector("#userid",                      { state: "visible", timeout: 45_000 }),
      page.waitForSelector('[data-testid="login-userid"]', { state: "visible", timeout: 45_000 }),
      page.waitForSelector('input[placeholder="User Name"]',{ state: "visible", timeout: 45_000 }),
    ]).catch(() => null);

    if (!userInput) {
      // Log debug nếu không tìm được ô login
      const snippet = (await page.content()).slice(0, 500);
      logger.error("BO login input not found", { url, title, snippet });
      throw new Error("Không tìm thấy ô đăng nhập sau 45s");
    }

    await userInput.fill(BO_USERNAME);
    await page.fill("#password", BO_PASSWORD).catch(() =>
      page.fill('[data-testid="login-password"]', BO_PASSWORD)
    );

    await Promise.all([
      page.waitForURL(url => !url.toString().includes("/login"), { timeout: 25_000 }),
      page.click('button:has-text("Login")'),
    ]);

    _loggedIn = true;
    logger.info("BO browser login OK");

  } catch (err) {
    try {
      const snippet = (await page.content()).slice(0, 500);
      logger.error("BO login failed", { error: err.message, snippet });
    } catch {}
    throw err;

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

    // Intercept API response
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

    // Điền username vào ô search Player ID
    const inputs = page.locator('input[placeholder="Please enter text"]');
    const count  = await inputs.count();
    if (!count) throw new Error("Không tìm thấy ô search Player ID");

    await inputs.nth(count - 1).fill(username);

    const respPromise = page.waitForResponse(
      resp => resp.url().includes("/deposits/search") && resp.status() === 200,
      { timeout: 15_000 }
    ).catch(() => null);

    await page.click('button:has-text("Search")');
    await respPromise;
    await page.waitForTimeout(500);

    // Parse JSON
    if (searchData) {
      const list = Array.isArray(searchData)           ? searchData
                 : Array.isArray(searchData?.data)     ? searchData.data
                 : Array.isArray(searchData?.list)     ? searchData.list
                 : Array.isArray(searchData?.items)    ? searchData.items
                 : Array.isArray(searchData?.deposits) ? searchData.deposits
                 : [];

      if (list.length > 0) {
        const match  = list.find(d => d.status === 1 || d.status === 0) || list[0];
        const remark = match?.remarks || null;
        logger.info("BO browser deposit found", { username, remark, status: match?.status });
        return remark;
      }
    }

    logger.warn("BO browser deposit remark not found", { username });
    return null;

  } catch (err) {
    logger.error("BO browser fetchDepositRemark failed", { username, error: err.message });
    _loggedIn = false;
    _context  = null;
    return null;
  } finally {
    await page?.close().catch(() => {});
  }
}

module.exports = { fetchDepositRemarkByUsername };
