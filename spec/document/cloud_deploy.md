# LearnFlow 雲端部署規劃（Cloud Deployment Plan）

> 版本：v1（2026-08）
> 範圍：正式環境的雲端架構選型與部署狀態。
> 相關文件：`deploy/DEPLOY_EC2.md`（既有的 EC2/Docker 部署）、`database_spec.md`、`api.md`。

## 1. 架構總表

| 元件 | 服務 | 規格 |
|------|------|------|
| Frontend | Azure Static Web Apps | Free |
| Backend | Azure Container Apps | Consumption |
| DB | Azure Database for PostgreSQL Flexible Server | B1MS |
| Audio / Image | Azure Blob Storage | LRS |
| DNS | Cloudflare | Free |
| SSL | Static Web Apps / Cloudflare | Free |
| Email | Resend / SendGrid 等 | 依使用量 |
| Payment | 綠界 ECPay | 交易抽成 |
| Monitoring | Application Insights | 控制用量 |

## 2. 各元件說明

### 2.1 Frontend — Static Web Apps（Free）

- 部署內容：`app/frontend`（純 HTML / CSS / JS，無 build step）。
- CI/CD：`.github/workflows/azure-static-web-apps-thankful-smoke-04639891e.yml`，push 到 `main` 自動部署。
- 路由：`app/frontend/staticwebapp.config.json` 將 `/` rewrite 到 `/html/index.html`（進入點在 `html/` 子目錄，頁面內資源用 `/css`、`/js` 絕對路徑）。
- Free 方案限制：無 SLA、100 GB/月頻寬、單一環境容量 250 MB。音檔不放這裡，走 Blob Storage。

### 2.2 Backend — Container Apps（Consumption）

- 應用：FastAPI（`app/backend/main.py`），沿用 `deploy/Dockerfile`。
- Consumption 方案可縮到 0 replica，閒置不計費；代價是冷啟動延遲。
- 對外只需暴露 API，不再由後端 serve 靜態檔（前端已切到 SWA）。

### 2.3 DB — PostgreSQL Flexible Server（B1MS）

- B1MS：1 vCore / 2 GB RAM，適合初期。
- 網路：限制只允許 Container Apps 的出口存取，不開放公網。
- Schema 來源：`spec/database/`。

### 2.4 Audio / Image — Blob Storage（LRS）

- 存放 `script/generate_audio*.py` 產生的語音檔與使用者上傳檔案（目前分別在 `app/frontend/audio/`、`app/backend/uploads/`，兩者都已 gitignore）。
- LRS 為單一區域備援，成本最低。

### 2.5 DNS / SSL — Cloudflare（Free）

- DNS 由 Cloudflare 管理，憑證由 SWA 自動簽發或走 Cloudflare。
- 注意 Cloudflare proxy 與 SWA 自訂網域驗證的相容設定。

### 2.6 Email / Payment / Monitoring

- Email：Resend 或 SendGrid，用於驗證信與通知，依使用量計費。
- Payment：綠界，採交易抽成。
- Monitoring：Application Insights，需設取樣率與資料保留上限以控制費用。

## 3. 目前進度

| 元件 | 狀態 |
|------|------|
| Static Web Apps | 已建立，CI/CD workflow 已進版控 |
| Container Apps | 未開始 |
| PostgreSQL Flexible Server | 未開始 |
| Blob Storage | 未開始 |
| Cloudflare DNS | 未開始 |
| Email / Payment / Monitoring | 未開始 |

## 4. 待處理事項

1. **前端 API base 需要改**：`app/frontend/js/api-config.js` 在 https 下會解析成 `${origin}/api`，而 SWA 的 `/api` 指向它自己的 Managed Functions，不是我們的 Container Apps。需改為指定 `window.LEARNFLOW_API_BASE` 到後端網址，或使用 SWA 的 linked backend。
2. **CORS**：後端改為獨立網域後，`main.py` 的 CORS 白名單要加上 SWA 網域與正式網域。
3. **環境變數 / 密鑰**：`.env` 內容改由 Container Apps secrets 提供，DB 連線字串不進版控。
4. **音檔搬遷**：前端目前以相對路徑讀 `audio/`，改用 Blob Storage 後需要一個 base URL 設定點。
5. **既有 EC2 部署的去留**：`deploy/DEPLOY_EC2.md` 與 `docker-compose.prod.yml` 是否保留為備援，待決定。
