# ST666 Full Fixed Backend Files

## Thay file
1. `server.js` → thay vào `src/server.js`
2. `boBrowser.js` → thêm/thay vào `src/boBrowser.js`
3. `package.json` → thay file `package.json` ở root repo

## Render Environment cần có
BO_LOGIN_URL=
BO_DEPOSIT_URL=
BO_USERNAME=
BO_PASSWORD=
PLAYWRIGHT_BROWSERS_PATH=0

## Render Build Command
npm install && PLAYWRIGHT_BROWSERS_PATH=0 npx playwright install chromium

## Render Start Command
npm start

## Deploy
Manual Deploy → Clear build cache & deploy

## Fix trong bản này
- Playwright cài browser vào node_modules bằng PLAYWRIGHT_BROWSERS_PATH=0
- Login BO bằng selector linh hoạt: #userid, data-testid, placeholder
- Timeout login tăng lên 45s
- Dùng stealth plugin nếu cài được
- Vào Deposit Audit, search Player ID
- Lấy cell dưới cột Deposit Remark bằng tọa độ header
- Đưa Deposit Remark vào dòng 4 Telegram caption
