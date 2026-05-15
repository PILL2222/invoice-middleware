"use strict";

/**
 * BO Browser Automation — lấy Deposit Remark bằng Playwright
 *
 * ENV cần có:
 * BO_LOGIN_URL=https://bo.bo666st.com/login
 * BO_DEPOSIT_URL=https://bo.bo666st.com/depositAudit
 * BO_USERNAME=invoice1
 * BO_PASSWORD=invoice1
 */

const { chromium } = require("playwright");
const logger = require("./logger");

const BO_LOGIN_URL = process.env.BO_LOGIN_URL || "https://bo.bo666st.com/login";
const BO_DEPOSIT_URL = process.env.BO_DEPOSIT_URL || "https://bo.bo666st.com/depositAudit";
const BO_USERNAME = process.env.BO_USERNAME;
const BO_PASSWORD = process.env.BO_PASSWORD;

async function safeClick(page, selector, timeout = 8000) {
  await page.waitForSelector(selector, { timeout });
  await page.click(selector);
}

async function safeFill(page, selector, value, timeout = 8000) {
  await page.waitForSelector(selector, { timeout });
  await page.fill(selector, value);
}

async function fetchDepositRemarkByUsername(username) {
  if (!BO_USERNAME || !BO_PASSWORD) {
    throw new Error("BO_USERNAME / BO_PASSWORD chưa được cấu hình");
  }

  if (!username) return null;

  let browser;

  try {
    browser = await chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
      ],
    });

    const context = await browser.newContext({
      viewport: { width: 1920, height: 1080 },
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",
    });

    const page = await context.newPage();

    logger.info("BO browser open login");
    await page.goto(BO_LOGIN_URL, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });

    // Login selectors lấy từ F12:
    await safeFill(page, "#userid", BO_USERNAME);
    await safeFill(page, "#password", BO_PASSWORD);

    await Promise.all([
      page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {}),
      page.click('button:has-text("Login")'),
    ]);

    await page.waitForTimeout(1500);

    logger.info("BO browser goto depositAudit");
    await page.goto(BO_DEPOSIT_URL, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });

    await page.waitForTimeout(2500);

    // Ô Player ID nằm ở Search By bên phải, input placeholder Please enter text.
    // Lấy input cuối cùng visible để tránh nhầm Deposit ID.
    const playerInputs = page.locator('input[placeholder="Please enter text"]');
    const count = await playerInputs.count();

    if (!count) {
      throw new Error("Không tìm thấy ô nhập Player ID");
    }

    const input = playerInputs.nth(count - 1);
    await input.fill(username);

    logger.info("BO browser search playerid", { username });

    await Promise.all([
      page.waitForResponse(
        resp => resp.url().includes("/deposits/search") && resp.status() === 200,
        { timeout: 30000 }
      ).catch(() => null),
      page.click('button:has-text("Search")'),
    ]);

    await page.waitForTimeout(2500);

    // Cách 1: lấy từ API response nếu còn trong performance/resource không tiện.
    // Cách 2: lấy theo tọa độ cột Deposit Remark trên UI.
    const remark = await page.evaluate(() => {
      const norm = s => (s || "").replace(/\s+/g, " ").trim();

      const headerSpan = [...document.querySelectorAll("span")]
        .find(el => norm(el.innerText) === "Deposit Remark");

      if (!headerSpan) return null;

      const headerBox = headerSpan.getBoundingClientRect();
      const headerCenterX = headerBox.left + headerBox.width / 2;

      const cells = [...document.querySelectorAll(".nrc-table-column, [class*='table-column'], [class*='column']")];

      let best = null;
      let bestScore = Infinity;

      for (const cell of cells) {
        const text = norm(cell.innerText);
        if (!text) continue;
        if (/Deposit Remark/i.test(text)) continue;
        if (/No Data/i.test(text)) continue;

        const box = cell.getBoundingClientRect();

        // chỉ lấy phần body bên dưới header
        if (box.top <= headerBox.bottom) continue;

        const centerX = box.left + box.width / 2;
        const diff = Math.abs(centerX - headerCenterX);

        if (diff < bestScore) {
          bestScore = diff;
          best = text;
        }
      }

      return best;
    });

    logger.info("BO browser remark result", { username, remark });

    return remark || null;
  } catch (err) {
    logger.error("BO browser fetchDepositRemark failed", {
      username,
      error: err.message,
    });
    return null;
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}

module.exports = { fetchDepositRemarkByUsername };
