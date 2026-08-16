# build context = 專案根目錄（與 Dockerfile.nginx 一致）
FROM python:3.13-slim

WORKDIR /app

COPY app/backend/requirements.txt backend/requirements.txt
RUN pip install --no-cache-dir -r backend/requirements.txt

COPY app/backend backend

EXPOSE 8002

CMD ["uvicorn", "backend.main:app", "--host", "0.0.0.0", "--port", "8002"]
