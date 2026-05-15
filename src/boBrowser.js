
"use strict";

const logger = require("./logger");

let chromium;
try {
  const { chromium: extraChromium } = require("playwright-extra");
  const stealth = require("puppeteer-extra-plugin-stealth")();
  extraChromium.use(stealth);
  chromium = extraChromium;
} catch (e) {
  chromium = require("playwright").chromium;
}

const BO_LOGIN_URL = process.env.BO_LOGIN_URL || "https://bo.bo666st.com/login";
const BO_DEPOSIT_URL = process.env.BO_DEPOSIT_URL || "https://bo.bo666st.com/depositAudit";
const BO_USERNAME = process.env.BO_USERNAME;
const BO_PASSWORD = process.env.BO_PASSWORD;

async function fillFirstVisible(page, selectors, value, timeout = 45000) {
  const end = Date.now() + timeout;

  while (Date.now() < end) {
    for (const selector of selectors) {
      try {
        const loc = page.locator(selector).first();
        if (await loc.count()) {
          if (await loc.isVisible({ timeout: 1000 }).catch(() => false)) {
            await loc.fill(value);
            return selector;
          }
        }
      } catch {}
    }
    await page.waitForTimeout(500);
  }

  throw new Error("Không tìm thấy input visible: " + selectors.join(" | "));
}

async function clickFirstVisible(page, selectors, timeout = 45000) {
  const end = Date.now() + timeout;

  while (Date.now() < end) {
    for (const selector of selectors) {
      try {
        const loc = page.locator(selector).first();
        if (await loc.count()) {
          if (await loc.isVisible({ timeout: 1000 }).catch(() => false)) {
            await loc.click();
            return selector;
          }
        }
      } catch {}
    }
    await page.waitForTimeout(500);
  }

  throw new Error("Không tìm thấy button visible: " + selectors.join(" | "));
}

function normalizeUsername(v) {
  return String(v || "").trim().toLowerCase();
}

function normalizeText(v) {
  return String(v || "").trim();
}

function getDateParts(dayRange = 1) {
  const now = Date.now();
  const start = new Date(now - dayRange * 86400000);
  const end = new Date(now + 86400000);

  const dateFrom = start.toISOString().slice(0, 10);
  const dateTo = end.toISOString().slice(0, 10);

  const starttime = new Date(`${dateFrom}T00:00:00+07:00`).getTime();
  const endtime = new Date(`${dateTo}T23:59:59+07:00`).getTime();

  return { dateFrom, dateTo, starttime, endtime };
}

async function loginBO(page) {
  logger.info("BO browser open login");

  await page.goto(BO_LOGIN_URL, {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  await page.waitForTimeout(3000);

  logger.info("BO browser login page", {
    url: page.url(),
    title: await page.title().catch(() => ""),
  });

  if (!page.url().includes("/login")) return;

  const userSelector = await fillFirstVisible(
    page,
    [
      "#userid",
      '[data-testid="login-userid"]',
      'input[placeholder="User Name"]',
      'input[type="text"].formik-input',
      'input[type="text"]',
    ],
    BO_USERNAME
  );

  const passSelector = await fillFirstVisible(
    page,
    [
      "#password",
      '[data-testid="login-password"]',
      'input[placeholder="Password"]',
      'input[type="password"].formik-input',
      'input[type="password"]',
    ],
    BO_PASSWORD
  );

  logger.info("BO browser login selectors", { userSelector, passSelector });

  await Promise.all([
    page.waitForLoadState("networkidle", { timeout: 45000 }).catch(() => {}),
    clickFirstVisible(page, [
      'button:has-text("Login")',
      'button[type="submit"]',
      ".nrc-button",
      "button",
    ]),
  ]);

  await page.waitForTimeout(5000);

  logger.info("BO browser after login", {
    url: page.url(),
    title: await page.title().catch(() => ""),
  });
}

async function fetchDepositListInsideBO(page, dayRange = 1) {
  const parts = getDateParts(dayRange);

  return await page.evaluate(async ({ dateFrom, dateTo, starttime, endtime }) => {
    const url =
      "https://boapi.bo666st.com/vh7prod-ims/api/v1/deposits/search" +
      `?dateFrom=${dateFrom}` +
      `&dateTo=${dateTo}` +
      `&endtime=${endtime}` +
      `&exactmatch=true` +
      `&language=1` +
      `&limit=100` +
      `&offset=0` +
      `&sort=DESC` +
      `&sortcolumn=deposittime` +
      `&starttime=${starttime}` +
      `&statusType=DEPOSIT_AUDIT` +
      `&timefilter=deposittime` +
      `&zoneType=ASIA_HO_CHI_MINH`;

    const res = await fetch(url, {
      method: "GET",
      credentials: "include",
      headers: {
        "Accept": "application/json, text/plain, */*",
        "X-Currency": "VND2",
      },
    });

    const text = await res.text();

    let json = null;
    try {
      json = JSON.parse(text);
    } catch {}

    return {
      ok: res.ok,
      status: res.status,
      url,
      json,
      text: text.slice(0, 1000),
    };
  }, parts);
}

function extractList(data) {
  if (!data) return [];
  if (Array.isArray(data)) return data;
  if (Array.isArray(data.data)) return data.data;
  if (Array.isArray(data.list)) return data.list;
  if (Array.isArray(data.items)) return data.items;
  if (Array.isArray(data.records)) return data.records;
  if (Array.isArray(data.deposits)) return data.deposits;
  if (data.data && Array.isArray(data.data.list)) return data.data.list;
  if (data.data && Array.isArray(data.data.items)) return data.data.items;
  if (data.data && Array.isArray(data.data.records)) return data.data.records;
  return [];
}

function pickDeposit(list, username, transferContent) {
  const u = normalizeUsername(username);
  const ck = normalizeText(transferContent).toLowerCase();

  let candidates = list.filter(item => normalizeUsername(item.playerid) === u);

  if (ck) {
    const matchedByCk = candidates.filter(item => {
      const bag = [
        item.remarks,
        item.thirdpartyorderno,
        item.depositid,
        item.postscript,
        item.ecremarks,
      ].map(x => normalizeText(x).toLowerCase()).join(" ");

      return bag.includes(ck);
    });

    if (matchedByCk.length) candidates = matchedByCk;
  }

  candidates.sort((a, b) => Number(b.deposittime || 0) - Number(a.deposittime || 0));

  return candidates[0] || null;
}

async function fetchDepositRemarkByUsername(username, transferContent = "") {
  if (!BO_USERNAME || !BO_PASSWORD) {
    throw new Error("BO_USERNAME / BO_PASSWORD chưa được cấu hình");
  }

  if (!username) return null;

  let browser;
  let page;

  try {
    browser = await chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--disable-blink-features=AutomationControlled",
      ],
    });

    const context = await browser.newContext({
      viewport: { width: 1920, height: 1080 },
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
      locale: "en-US",
      timezoneId: "Asia/Ho_Chi_Minh",
    });

    page = await context.newPage();

    await loginBO(page);

    logger.info("BO browser goto depositAudit");

    await page.goto(BO_DEPOSIT_URL, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });

    await page.waitForTimeout(5000);

    let apiResult = await fetchDepositListInsideBO(page, 1);
    let list = extractList(apiResult.json);

    logger.info("BO browser API list parsed", {
      username,
      dayRange: 1,
      status: apiResult.status,
      count: list.length,
      total: apiResult.json?.total ?? null,
    });

    if (!list.length) {
      apiResult = await fetchDepositListInsideBO(page, 7);
      list = extractList(apiResult.json);

      logger.info("BO browser API list parsed", {
        username,
        dayRange: 7,
        status: apiResult.status,
        count: list.length,
        total: apiResult.json?.total ?? null,
      });
    }

    const selected = pickDeposit(list, username, transferContent);
    const remark = selected?.remarks || selected?.thirdpartyorderno || null;

    logger.info("BO browser remark result (API list local filter)", {
      username,
      transferContent,
      foundPlayer: !!selected,
      playerid: selected?.playerid || null,
      remark,
      depositid: selected?.depositid || null,
      deposittime: selected?.deposittime || null,
    });

    return remark || null;
  } catch (err) {
    let debug = {};

    try {
      debug = {
        url: page ? page.url() : null,
        title: page ? await page.title().catch(() => "") : "",
        html: page ? (await page.content()).slice(0, 1500) : "",
      };
    } catch {}

    logger.error("BO browser fetchDepositRemark failed", {
      username,
      error: err.message,
      ...debug,
    });

    return null;
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}

module.exports = {
  fetchDepositRemarkByUsername,
};
