# AWS EC2 部署指南（Docker Hub）

> 試營運架構：本地 build → push Docker Hub → EC2 只 pull 執行  
> **EC2 不需要 git clone，不需要 build**

---

## 1. 兩份 Compose 的差別

| 檔案 | 用途 | 在哪用 |
|------|------|--------|
| `docker-compose.yml` | 含 `build:`，本地開發 / 整合測試 | 你的 Mac |
| `docker-compose.prod.yml` | 含 `image:`，從 Docker Hub pull | EC2 |

```text
本地（Mac）                          EC2
─────────────                       ────
docker-compose.yml                  docker-compose.prod.yml
  build backend                       pull backend image
  nginx 掛載 ../app/frontend          pull nginx image（前端已打包）
```

PostgreSQL 兩邊都用官方 `postgres:16-alpine`，不用 push。

---

## 2. 架構

```text
Internet → EC2:80 (nginx image) → 靜態前端
                               → /api/* → backend image → postgres + volume
```

Docker Hub 上需要的 images：

| Image | 說明 |
|-------|------|
| `<DOCKERHUB_USER>/learnflow-backend:<tag>` | FastAPI |
| `<DOCKERHUB_USER>/learnflow-nginx:<tag>` | Nginx + HTML/CSS/JS |

---

## 3. 本地：Build 並 Push 到 Docker Hub

### 3.1 登入 Docker Hub

```bash
docker login
```

### 3.2 Build & Push

```bash
cd "/Users/william/Documents/project/LearnFlow"

export DOCKERHUB_USER=你的帳號
export IMAGE_TAG=latest    # 或 0.1.0、20260613 等版本號

./deploy/scripts/build-and-push.sh
```

腳本會 build 並 push 兩個 image。之後每次改程式，重跑此腳本再更新 EC2。

---

## 4. EC2 上要放的檔案（不用整包 repo）

EC2 只需一個小目錄，例如 `/opt/learnflow/`：

```text
/opt/learnflow/
├── docker-compose.prod.yml    # 從 repo deploy/ 複製
├── .env                       # 從 .env.prod.example 改寫
├── init/
│   └── 001_extensions.sql     # 首次 DB 初始化（可選）
└── data/
    └── audio/                 # 語音 MP3（scp 上傳，可後補）
```

### 4.1 上傳 deploy 檔案到 EC2

```bash
# 在本地執行
scp -i ~/.ssh/your-key.pem \
  deploy/docker-compose.prod.yml \
  deploy/.env.prod.example \
  ec2-user@<EC2_IP>:~/learnflow/

scp -i ~/.ssh/your-key.pem -r \
  deploy/init \
  ec2-user@<EC2_IP>:~/learnflow/
```

SSH 進 EC2 後：

```bash
cd ~/learnflow
cp .env.prod.example .env
nano .env   # 改 POSTGRES_PASSWORD、DOCKERHUB_USER
mkdir -p data/audio
```

`.env` 範例：

```env
POSTGRES_USER=learnflow
POSTGRES_PASSWORD=<強密碼>
POSTGRES_DB=learnflow
DOCKERHUB_USER=你的帳號
IMAGE_TAG=latest
NGINX_PORT=80
```

### 4.2 安裝 Docker（EC2 首次）

```bash
sudo apt update && sudo apt upgrade -y
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER
newgrp docker
```

### 4.3 Pull 並啟動

```bash
cd ~/learnflow
docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml up -d
docker compose -f docker-compose.prod.yml ps
```

---

## 5. 資料庫

### 方式 A：EC2 全新環境，手動跑 SQL

```bash
docker exec -it learnflow-db psql -U learnflow -d learnflow
```

貼上 [`spec/operate/SQL.md`](../spec/operate/SQL.md) 內容。

### 方式 B：從本地 pg_dump 搬上去

```bash
# 本地匯出
docker exec learnflow-db pg_dump -U learnflow -d learnflow -F c -f /tmp/learnflow.dump
docker cp learnflow-db:/tmp/learnflow.dump ./learnflow.dump
scp -i ~/.ssh/your-key.pem learnflow.dump ec2-user@<EC2_IP>:~/

# EC2 還原
docker cp ~/learnflow.dump learnflow-db:/tmp/learnflow.dump
docker exec learnflow-db pg_restore -U learnflow -d learnflow --clean --if-exists /tmp/learnflow.dump
```

DB 資料在 EC2 的 Docker volume `learnflow-postgres-data`，與 image 無關，更新 image 不會清掉 DB。

---

## 6. 語音檔

語音 **不打包進 nginx image**（避免 image 過大），EC2 掛載 `./data/audio/`：

```bash
# 本地 scp 語音檔到 EC2
scp -i ~/.ssh/your-key.pem -r app/frontend/audio/* ec2-user@<EC2_IP>:~/learnflow/data/audio/
```

---

## 7. 更新版本（日常流程）

```text
本地改 code
  → ./deploy/scripts/build-and-push.sh
  → EC2: docker compose -f docker-compose.prod.yml pull && docker compose -f docker-compose.prod.yml up -d
```

若只改 `.env` 的 `IMAGE_TAG`：

```bash
# EC2
docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml up -d
```

---

## 8. 常用指令（EC2）

```bash
cd ~/learnflow

# 狀態
docker compose -f docker-compose.prod.yml ps

# Log
docker compose -f docker-compose.prod.yml logs -f backend

# 停止（保留 DB）
docker compose -f docker-compose.prod.yml down

# 備份 DB
docker exec learnflow-db pg_dump -U learnflow -d learnflow -F c -f /tmp/backup.dump
docker cp learnflow-db:/tmp/backup.dump ~/
```

---

## 9. 常見問題

| 狀況 | 處理 |
|------|------|
| pull 失敗 401 | EC2 執行 `docker login`（私有 repo 才需要；公開 repo 不用） |
| image 找不到 | 確認 `.env` 的 `DOCKERHUB_USER`、`IMAGE_TAG` 與 push 時一致 |
| 更新了 code 但 EC2 沒變 | 有 push 新 tag 嗎？EC2 有 `pull` 嗎？ |
| 前端改了沒上去 | 前端在 **nginx image** 裡，需 rebuild + push nginx |
| 後端改了沒上去 | rebuild + push **backend** image |
| API 502 | `docker compose -f docker-compose.prod.yml logs backend` |

---

## 10. 後續可加

- CI（GitHub Actions）自動跑 `build-and-push.sh`
- EC2 用 webhook / SSH 自動 `pull && up -d`
- HTTPS：Caddy / ALB + ACM
- 私有 Docker Hub repo 或 AWS ECR（把 `DOCKERHUB_USER/image` 換成 ECR URI 即可，compose 概念相同）
