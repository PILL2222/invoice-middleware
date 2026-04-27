/**
 * imageMatch.js — So khớp ảnh KHÔNG dùng sharp
 * Dùng thuần JavaScript + axios (đã có sẵn)
 * Phương pháp: so sánh kích thước file + metadata thay vì pixel hash
 * Kết hợp với text matching (nội dung CK) là tiêu chí chính
 */

const axios = require("axios");
const logger = require("./logger");

const MATCH_THRESHOLD = 15;

// Download ảnh từ URL → buffer
async function downloadImage(url, token = null) {
  try {
    const headers = {};
    if (token) headers["Authorization"] = `Bearer ${token}`;
    const res = await axios.get(url, {
      responseType: "arraybuffer",
      timeout: 15000,
      headers,
    });
    return Buffer.from(res.data);
  } catch (err) {
    logger.error("downloadImage error", { url: url?.slice(0,60), error: err.message });
    return null;
  }
}

// Hash đơn giản từ buffer: dùng kích thước + sample bytes
function computeHash(imageBuffer) {
  try {
    if (!imageBuffer || imageBuffer.length < 100) return null;
    const size = imageBuffer.length;
    // Lấy 64 byte mẫu ở các vị trí khác nhau
    const samples = [];
    for (let i = 0; i < 64; i++) {
      const pos = Math.floor((size / 64) * i);
      samples.push(imageBuffer[pos]);
    }
    const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
    const hash = samples.map(v => v >= avg ? "1" : "0").join("");
    return { hash, size };
  } catch (err) {
    logger.error("computeHash error", { error: err.message });
    return null;
  }
}

// Hamming distance
function hammingDistance(h1, h2) {
  if (!h1 || !h2 || h1.length !== h2.length) return 999;
  let d = 0;
  for (let i = 0; i < h1.length; i++) if (h1[i] !== h2[i]) d++;
  return d;
}

// So sánh ảnh khách với danh sách ảnh Telegram
async function findMatchingInvoice(customerImageBuffer, telegramImages) {
  const customerData = computeHash(customerImageBuffer);
  if (!customerData) return null;

  let bestMatch = null;
  let bestScore = 999;

  for (const img of telegramImages) {
    if (!img.hash) continue;
    const dist = hammingDistance(customerData.hash, img.hash);
    // Thêm bonus nếu kích thước file gần nhau (±20%)
    let score = dist;
    if (img.size && customerData.size) {
      const sizeRatio = Math.abs(img.size - customerData.size) / Math.max(img.size, customerData.size);
      if (sizeRatio > 0.5) score += 10; // Phạt nếu kích thước khác nhau quá nhiều
    }
    if (score < bestScore) { bestScore = score; bestMatch = { ...img, distance: score }; }
  }

  if (bestScore < MATCH_THRESHOLD) {
    logger.info("Image match found", { distance: bestScore });
    return bestMatch;
  }
  logger.info("No image match", { bestScore, checked: telegramImages.length });
  return null;
}

module.exports = { computeHash, hammingDistance, downloadImage, findMatchingInvoice, MATCH_THRESHOLD };
