# LearnFlow

以「情境內容探索」為核心的語文學習 Web 原型（英文 & 日文）。

產品規格與 API / 資料庫設計請見：

- [`spec/document/PRODUCT_SPEC.md`](spec/document/PRODUCT_SPEC.md)
- [`spec/document/api.md`](spec/document/api.md)
- [`spec/document/database_spec.md`](spec/document/database_spec.md)
- [`spec/database/schema.sql`](spec/database/schema.sql) — 資料表與索引（純 DDL）
- [`spec/operate/scenario_seed.sql`](spec/operate/scenario_seed.sql) — 建表 + 種子資料
- [`spec/operate/SQL.md`](spec/operate/SQL.md) — 種子資料維護與產生器

## 專案結構

```text
LearnFlow/
├── app/
│   ├── frontend/          # 純 HTML / CSS / JS
│   │   ├── html/
│   │   ├── css/
│   │   ├── js/
│   │   └── audio/         # 語音檔（MP3）
│   └── backend/
│       ├── main.py        # FastAPI 入口
│       ├── api/           # API routes
│       ├── module/        # schema、repository
│       └── database/      # PostgreSQL 連線池
├── deploy/
│   ├── docker-compose.yml # PostgreSQL + Backend + Nginx
│   ├── Dockerfile
│   └── nginx/
├── spec/
│   ├── database/          # schema.sql（純 DDL）
│   └── operate/           # scenario_seed.sql（DDL + 種子）
```

---

## 資料庫建表與種子資料

### SQL 檔案

| 檔案 | 用途 |
|------|------|
| [`spec/database/schema.sql`](spec/database/schema.sql) | 純 DDL：ENUM、資料表、索引 |
| [`spec/operate/scenario_seed.sql`](spec/operate/scenario_seed.sql) | DDL + 種子資料（會 DROP 重建內容表） |
| [`spec/document/database_spec.md`](spec/document/database_spec.md) | 完整產品規格（含尚未實作的 users、進度等表） |

目前實作範圍：

```text
scenarios
  └── courses
        ├── course_sentences
        └── course_vocabulary
```

### 只看結構

```bash
cat spec/database/schema.sql
```

### 全新資料庫（建表 + 匯入種子）

先確認 PostgreSQL 已啟動，並設定連線字串（與專案根目錄 `.env` 的 `DATABASE_URL` 相同）：

```bash
export DATABASE_URL=postgresql://learnflow:learnflow_dev@127.0.0.1:5433/learnflow

psql "$DATABASE_URL" -f spec/database/schema.sql
psql "$DATABASE_URL" -f spec/operate/scenario_seed.sql
```

> `scenario_seed.sql` 內含相同 DDL。若只需匯入資料，**只跑第二行**即可。

### 使用 Docker 容器執行（venv / Compose 皆適用）

PostgreSQL 容器名為 `learnflow-db` 時：

```bash
docker exec -i learnflow-db psql -U learnflow -d learnflow < spec/database/schema.sql
docker exec -i learnflow-db psql -U learnflow -d learnflow < spec/operate/scenario_seed.sql
```

### 只更新種子資料

```bash
# 1. 改 spec/operate/seed_content.py
# 2. 重新產生 SQL
python spec/operate/generate_scenario_seed.py
# 3. 匯入（會 DROP 重建四張內容表）
psql "$DATABASE_URL" -f spec/operate/scenario_seed.sql
```

詳細操作與資料規模見 [`spec/operate/SQL.md`](spec/operate/SQL.md)。

---

## 方式一：Python venv 本地開發

適合日常開發與 API 測試。FastAPI 同時提供 API 與靜態前端。

### 1. 建立虛擬環境並安裝依賴

```bash
cd app
python3 -m venv .venv
source .venv/bin/activate        # Windows: .venv\Scripts\activate
pip install -r backend/requirements.txt
```

### 2. 啟動 PostgreSQL（Docker 只跑 DB）

```bash
cd deploy
docker compose -f docker-compose.yml --env-file ../.env up -d postgres
```

（若尚未建立根目錄 `.env`，見下方「環境變數」一節。）

### 3. 寫入情境資料

依上方「[資料庫建表與種子資料](#資料庫建表與種子資料)」執行。venv 開發時常用：

```bash
export DATABASE_URL=postgresql://learnflow:learnflow_dev@127.0.0.1:5433/learnflow
psql "$DATABASE_URL" -f spec/database/schema.sql
psql "$DATABASE_URL" -f spec/operate/scenario_seed.sql
```

### 4. 設定環境變數

在**專案根目錄**（`LearnFlow/`）建立 `.env`：

```bash
cp .env.example .env
# 編輯 .env，填入 SECRET_KEY、GOOGLE_CLIENT_ID 等
```

`.env` 同時供 **venv 本地開發** 與 **Docker Compose** 使用。

### 5. 啟動後端

```bash
cd app
source .venv/bin/activate
uvicorn backend.main:app --reload --port 8002
```

瀏覽器開啟：<http://127.0.0.1:8002>

前端已對接情境學習 API，可操作：

1. **情境探索** — 瀏覽英文 / 日文情境列表
2. **查看課程** — 進入情境後看到 3 堂由淺入深的課程
3. **開始學習** — 逐句瀏覽、播放語音（需放置 MP3 至 `app/frontend/audio/`）

### 6. 測試 API

```bash
# 健康檢查
curl http://127.0.0.1:8002/api/health

# 情境列表
curl http://127.0.0.1:8002/api/scenarios

# 英文情境
curl "http://127.0.0.1:8002/api/scenarios?language=english"

# 單一情境（含課程列表）
curl http://127.0.0.1:8002/api/scenarios/en-cafe

# 課程詳情（句子 + 單字）
curl http://127.0.0.1:8002/api/scenarios/en-cafe/courses/en-cafe-l01
```

Swagger UI：<http://127.0.0.1:8002/docs>

### venv 常見問題

| 狀況 | 處理方式 |
|------|----------|
| API 回傳 503 | 確認專案根目錄 `.env` 有設定 `DATABASE_URL`，且 PostgreSQL 已啟動 |
| 情境列表為空 | 確認已執行 `spec/operate/scenario_seed.sql` |
| `asyncpg` 找不到 | 確認 venv 已 activate 並重新 `pip install -r backend/requirements.txt` |

---

## 方式二：Docker Compose 一鍵部署

適合整合測試與接近正式環境的部署。架構如下：

```text
瀏覽器 → Nginx (:80) → 靜態前端 (HTML/CSS/JS/Audio)
                      → /api/* 反向代理 → FastAPI Backend (:8002)
                                              ↓
                                         PostgreSQL (:5432)
```

### 1. 設定環境變數

在**專案根目錄**建立 `.env`（若 venv 開發時已建可沿用）：

```bash
cp .env.example .env
```

`.env` 預設含 PostgreSQL、Auth、Nginx port 等設定。

### 2. 啟動所有服務

在**專案根目錄**執行：

```bash
docker compose -f deploy/docker-compose.yml --env-file .env up -d --build
```

確認容器狀態：

```bash
docker compose ps
```

應看到 `postgres`、`backend`、`nginx` 三個服務皆為 `running`。

### 3. 寫入情境資料

PostgreSQL 啟動後（只需做一次），在專案根目錄執行：

```bash
docker exec -i learnflow-db psql -U learnflow -d learnflow < spec/database/schema.sql
docker exec -i learnflow-db psql -U learnflow -d learnflow < spec/operate/scenario_seed.sql
```

亦可參考上方「[資料庫建表與種子資料](#資料庫建表與種子資料)」。

### 4. 存取服務

| 服務 | URL |
|------|-----|
| 前端（Nginx） | <http://localhost> |
| API（經 Nginx 代理） | <http://localhost/api/scenarios> |
| Swagger UI | <http://localhost/docs> |
| PostgreSQL | `localhost:5433`（避開 Mac 本機 5432） |

### 5. 測試 API

```bash
curl http://localhost/api/health
curl http://localhost/api/scenarios
curl http://localhost/api/scenarios/jp-dessert-cafe/courses/jp-dessert-l01
```

### 6. 常用 Docker 指令

```bash
# 查看 log
docker compose logs -f
docker compose logs -f backend
docker compose logs -f nginx

# 停止（保留 DB 資料）
docker compose down

# 停止並清除 DB 資料（慎用！會刪除 volume）
docker compose down -v

# 只重建 backend
docker compose up -d --build backend
```

### Docker 常見問題

| 狀況 | 處理方式 |
|------|----------|
| 前端可開但 API 502 | `docker compose logs backend` 確認後端是否正常連 DB |
| port 80 被佔用 | 修改根目錄 `.env` 的 `NGINX_PORT=8080`，改開 <http://localhost:8080> |
| 修改後端程式碼 | 執行 `docker compose up -d --build backend` 重建映像 |
| 修改前端靜態檔 | Nginx 已掛載 `app/frontend/`，存檔後重新整理瀏覽器即可 |

### 7. 資料庫 Volume

PostgreSQL **有掛載 Docker Volume**，資料會持久保存：

| 項目 | 值 |
|------|-----|
| Compose 定義 | `postgres_data` |
| 實際 Volume 名稱 | `learnflow-postgres-data` |
| 容器內路徑 | `/var/lib/postgresql/data` |

```bash
# 查看 volume
docker volume ls | grep learnflow

# 查看 volume 詳細資訊
docker volume inspect learnflow-postgres-data
```

- `docker compose down` → 容器停止，**資料保留**
- `docker compose down -v` → 容器停止，**資料被刪除**
- 重新 `docker compose up -d postgres` → 資料仍在

---

## 部署至 AWS EC2（Docker Hub）

試營運採 **本地 build → push Docker Hub → EC2 pull**，不在 EC2 上 git clone 或 build。

| Compose 檔 | 用途 |
|------------|------|
| `deploy/docker-compose.yml` | 本地開發（含 `build:`） |
| `deploy/docker-compose.prod.yml` | EC2 正式環境（只 `pull` image） |

詳細步驟見 [`deploy/DEPLOY_EC2.md`](deploy/DEPLOY_EC2.md)。

### 本地 push image

```bash
export DOCKERHUB_USER=你的帳號
export IMAGE_TAG=latest
./deploy/scripts/build-and-push.sh
```

會 push 兩個 image：`learnflow-backend`、`learnflow-nginx`（含前端靜態檔）。

### EC2 啟動

EC2 只需小目錄（`docker-compose.prod.yml` + `.env` + `data/audio/`），不需整包 repo：

```bash
docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml up -d
```

### 本地 DB 資料搬上 EC2

**推薦用 `pg_dump` 匯出再還原**（跨機器最穩）：

```bash
# 1. 本地匯出
docker exec learnflow-db pg_dump -U learnflow -d learnflow -F c -f /tmp/learnflow.dump
docker cp learnflow-db:/tmp/learnflow.dump ./learnflow.dump

# 2. 上傳到 EC2
scp -i your-key.pem learnflow.dump ec2-user@<EC2_IP>:~/

# 3. EC2 上還原（docker compose 已啟動 postgres 後）
docker cp ~/learnflow.dump learnflow-db:/tmp/learnflow.dump
docker exec learnflow-db pg_restore -U learnflow -d learnflow --clean --if-exists /tmp/learnflow.dump
```

若 EC2 是全新環境，也可在容器內重跑 `spec/operate/scenario_seed.sql`（見「[資料庫建表與種子資料](#資料庫建表與種子資料)」）。

### EC2 快速步驟

1. 開 EC2，Security Group 開 **22**、**80**
2. 安裝 Docker
3. scp 上傳 `docker-compose.prod.yml`、`.env`（見 `deploy/.env.prod.example`）
4. `docker compose -f docker-compose.prod.yml pull && up -d`
5. 還原 DB 或跑 SQL 種子
6. 開啟 `http://<EC2_PUBLIC_IP>`

---

## 兩種方式比較

| | venv 本地開發 | Docker Compose |
|--|--------------|----------------|
| 前端 | FastAPI 直接提供 | Nginx 提供 |
| 後端 | 本機 uvicorn `--reload` | 容器內 uvicorn |
| 資料庫 | Docker 只跑 postgres | Docker 跑 postgres |
| 熱重載 | 後端程式自動重載 | 需 rebuild backend |
| 適合場景 | 日常開發、除錯 | 整合測試、Demo 部署 |

---

## 目前 API（情境學習 v1）

| Method | Path | 說明 |
|--------|------|------|
| GET | `/api/health` | 健康檢查 |
| GET | `/api/scenarios` | 情境列表（`?language=english`） |
| GET | `/api/scenarios/{id}` | 情境詳情 + 課程列表 |
| GET | `/api/scenarios/{id}/courses/{course_id}` | 課程 + 句子 + 單字 |
