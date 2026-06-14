# LearnFlow API 設計規格

> 版本：0.1.0  
> 最後更新：2026-06-13  
> 對應文件：[`PRODUCT_SPEC.md`](./PRODUCT_SPEC.md)、[`database_spec.md`](./database_spec.md)

---

## 1. 概述

LearnFlow 後端以 **FastAPI** 提供 RESTful JSON API，服務首頁 Dashboard、學習探索、情境學習、AI 對話、複習、收藏、進度分析與使用者設定等前端頁面。

### 1.1 設計原則

| 原則 | 說明 |
|------|------|
| 資源導向 | URL 以名詞表示資源，動作用 HTTP Method 表達 |
| 使用者隔離 | 除公開內容外，所有個人化資料需 JWT 驗證 |
| 情境優先 | 核心資源為 `Scenario`，單字、句型、對話皆圍繞情境組織 |
| 漸進式實作 | Phase 1 沿用 mock；Phase 2 接 PostgreSQL；Phase 3 接 AI / 語音 |
| 合規可追溯 | 情境內容必須帶 `ContentSource` 與授權狀態 |

### 1.2 Base URL

| 環境 | URL |
|------|-----|
| 本地開發 | `http://127.0.0.1:8002/api` |
| Docker 部署 | `http://localhost:8002/api` |

### 1.3 通用慣例

#### 認證

除標記 `Public` 的端點外，請求 Header 需帶：

```http
Authorization: Bearer <access_token>
```

#### 分頁

列表型 API 支援：

| 參數 | 型別 | 預設 | 說明 |
|------|------|------|------|
| `page` | int | 1 | 頁碼，從 1 開始 |
| `page_size` | int | 20 | 每頁筆數，上限 100 |

回應格式：

```json
{
  "items": [],
  "total": 128,
  "page": 1,
  "page_size": 20,
  "has_next": true
}
```

#### 錯誤回應

```json
{
  "error": {
    "code": "SCENARIO_NOT_FOUND",
    "message": "找不到指定情境",
    "details": {}
  }
}
```

| HTTP Status | 用途 |
|-------------|------|
| 400 | 請求參數錯誤 |
| 401 | 未登入或 Token 失效 |
| 403 | 無權限 |
| 404 | 資源不存在 |
| 409 | 衝突（如 email 已註冊） |
| 422 | 驗證失敗 |
| 500 | 伺服器錯誤 |

#### 列舉值

與 Pydantic schema 及資料庫 enum 保持一致：

- **Language**: `english` \| `japanese` \| `korean`
- **Level**: `beginner` \| `intermediate` \| `advanced`
- **SourceStatus**: `licensed` \| `summarized` \| `attribution_required`
- **LessonStepType**: `story` \| `listening` \| `reading` \| `vocabulary` \| `sentence_pattern` \| `speaking` \| `conversation` \| `quiz` \| `result`
- **ConversationMode**: `roleplay` \| `drama_task` \| `news_discussion` \| `free_practice`
- **SavedItemType**: `scenario` \| `vocabulary` \| `sentence` \| `conversation` \| `news`

---

## 2. API 總覽

### 2.1 已實作（Mock 階段）

| Method | Path | 說明 | 狀態 |
|--------|------|------|------|
| GET | `/health` | 健康檢查 | ✅ 已實作 |
| GET | `/dashboard` | 首頁聚合資料 | ✅ 已實作 |
| GET | `/scenarios` | 情境列表 | ✅ 已實作 |
| GET | `/scenarios/{id}` | 情境詳情 | ✅ 已實作 |
| GET | `/review` | 複習佇列 | ✅ 已實作 |
| POST | `/conversation` | AI 對話一輪 | ✅ 已實作 |
| POST | `/progress` | 儲存進度 | ✅ 已實作 |

### 2.2 待實作（Phase 2 起）

| 模組 | 端點數 | 優先級 |
|------|--------|--------|
| 認證 Auth | 8 | P0 |
| 使用者 User | 4 | P0 |
| 首頁 Dashboard | 3 | P0 |
| 情境 Scenarios | 5 | P0 |
| 學習流程 Learning | 4 | P0 |
| 複習 Review | 5 | P0 |
| 單字卡 Vocabulary | 4 | P1 |
| 句子練習 Sentences | 4 | P1 |
| AI 對話 Conversation | 6 | P1 |
| 收藏 Saved | 3 | P1 |
| 進度分析 Analytics | 4 | P1 |
| 搜尋 Search | 2 | P2 |
| 通知 Notifications | 3 | P2 |
| 語音 Speech | 2 | P3 |
| 內容管理 Content | 4 | P4 |

---

## 3. 認證模組（Auth）

> 對應 UI：登入頁（Email / Google OAuth / 忘記密碼 / 註冊）

### 3.1 POST `/auth/register` — 註冊

**Public**

**Request**

```json
{
  "email": "alex@example.com",
  "password": "SecurePass123!",
  "name": "Alex",
  "native_language": "zh-TW"
}
```

**Response 201**

```json
{
  "user": {
    "id": "uuid",
    "email": "alex@example.com",
    "name": "Alex"
  },
  "access_token": "eyJ...",
  "refresh_token": "eyJ...",
  "token_type": "bearer",
  "expires_in": 3600
}
```

**錯誤**：409 email 已存在；422 密碼強度不足

---

### 3.2 POST `/auth/login` — Email 登入

**Public**

**Request**

```json
{
  "email": "alex@example.com",
  "password": "SecurePass123!"
}
```

**Response 200**：同 register 回應格式

**錯誤**：401 帳密錯誤

---

### 3.3 GET `/auth/google` — Google OAuth 導向

**Public**

將使用者導向 Google 授權頁。Query：

| 參數 | 說明 |
|------|------|
| `redirect_uri` | 前端 callback URL |

---

### 3.4 GET `/auth/google/callback` — Google OAuth 回調

**Public**

Google 授權完成後交換 token，建立或連結使用者帳號，回傳 JWT。

---

### 3.5 POST `/auth/refresh` — 刷新 Token

**Public**（需有效 refresh_token）

**Request**

```json
{
  "refresh_token": "eyJ..."
}
```

**Response 200**

```json
{
  "access_token": "eyJ...",
  "expires_in": 3600
}
```

---

### 3.6 POST `/auth/logout` — 登出

使 refresh token 失效（加入黑名單或刪除紀錄）。

---

### 3.7 POST `/auth/forgot-password` — 忘記密碼

**Public**

**Request**

```json
{
  "email": "alex@example.com"
}
```

**Response 200**：一律回傳成功訊息（避免 email 枚舉）

```json
{
  "message": "若該 email 已註冊，重設連結已寄出"
}
```

---

### 3.8 POST `/auth/reset-password` — 重設密碼

**Public**

**Request**

```json
{
  "token": "reset-token-from-email",
  "new_password": "NewSecurePass123!"
}
```

---

## 4. 使用者模組（User）

### 4.1 GET `/users/me` — 取得個人資料

**Response 200**

```json
{
  "id": "uuid",
  "email": "alex@example.com",
  "name": "Alex",
  "avatar_url": null,
  "native_language": "zh-TW",
  "active_languages": ["english", "japanese"],
  "level": "beginner",
  "interests": ["影劇", "旅行", "科技"],
  "daily_goal_minutes": 35,
  "subscription_tier": "free",
  "created_at": "2026-01-15T08:00:00+08:00"
}
```

---

### 4.2 PATCH `/users/me` — 更新基本資料

**Request**（部分更新）

```json
{
  "name": "Alex Chen",
  "avatar_url": "https://..."
}
```

---

### 4.3 PATCH `/users/me/preferences` — 更新學習偏好

**Request**

```json
{
  "active_languages": ["japanese"],
  "level": "intermediate",
  "interests": ["旅行", "美食", "時事"],
  "daily_goal_minutes": 45,
  "speech_speed": 1.0,
  "ai_feedback_strictness": "normal",
  "ui_language": "zh-TW"
}
```

| 欄位 | 說明 |
|------|------|
| `speech_speed` | 0.75 ~ 1.5 |
| `ai_feedback_strictness` | `gentle` \| `normal` \| `strict` |

---

### 4.4 DELETE `/users/me` — 刪除帳號

軟刪除使用者及關聯個人資料（GDPR 考量）。

---

## 5. 首頁 Dashboard 模組

> 對應 UI：首頁 — 今日進度、繼續學習、推薦課程、學習捷徑、學習日曆、AI 對話練習、學習分析

### 5.1 GET `/dashboard` — 首頁聚合資料

**現有端點，Phase 2 改為從 DB 聚合**

**Query**

| 參數 | 說明 |
|------|------|
| `language` | 篩選當前語言上下文，預設使用者主要語言 |

**Response 200**

```json
{
  "profile": { "...": "見 UserProfile" },
  "stats": {
    "completion_rate": 72,
    "learning_minutes": 25,
    "goal_minutes": 35,
    "finished_lessons": 2,
    "total_lessons": 3,
    "streak_days": 7,
    "best_streak_days": 14
  },
  "current_scenario": { "...": "見 Scenario" },
  "recommended_scenarios": [],
  "trending_scenarios": [],
  "shortcuts": {
    "vocabulary_due_count": 128,
    "sentence_due_count": 24,
    "favorites_count": 18
  },
  "ai_chat_preview": {
    "scenario_id": "jp-cafe-001",
    "title": "旅行：在咖啡廳點餐",
    "level": "beginner",
    "last_message_preview": {
      "target_text": "いらっしゃいませ。",
      "reading": "Irasshaimase.",
      "translation": "歡迎光臨。"
    }
  },
  "analysis_summary": {
    "score": 86,
    "strengths": ["發音清楚", "句型運用正確"],
    "improvements": ["語調可更自然", "敬語運用可加強"]
  }
}
```

---

### 5.2 GET `/dashboard/calendar` — 學習日曆

**Query**

| 參數 | 說明 |
|------|------|
| `year` | 年份，如 2026 |
| `month` | 月份 1-12 |

**Response 200**

```json
{
  "year": 2026,
  "month": 6,
  "days": [
    {
      "date": "2026-06-01",
      "activity_level": "full",
      "minutes_spent": 38,
      "scenarios_completed": 2
    },
    {
      "date": "2026-06-02",
      "activity_level": "partial",
      "minutes_spent": 15,
      "scenarios_completed": 0
    },
    {
      "date": "2026-06-03",
      "activity_level": "none",
      "minutes_spent": 0,
      "scenarios_completed": 0
    }
  ]
}
```

`activity_level`: `none` \| `partial` \| `full`（依 daily_goal 達成比例計算）

---

### 5.3 GET `/dashboard/daily-tasks` — 今日任務

**Response 200**

```json
{
  "date": "2026-06-13",
  "tasks": [
    {
      "id": "complete_scenario",
      "title": "完成 1 個情境",
      "target": 1,
      "current": 0,
      "completed": false
    },
    {
      "id": "review_vocabulary",
      "title": "複習 5 個單字",
      "target": 5,
      "current": 3,
      "completed": false
    },
    {
      "id": "ai_conversation",
      "title": "完成 1 次 AI 對話",
      "target": 1,
      "current": 1,
      "completed": true
    }
  ],
  "all_completed": false
}
```

---

## 6. 情境模組（Scenarios）

> 對應 UI：學習探索頁、首頁推薦課程、繼續學習卡片

### 6.1 GET `/scenarios` — 情境列表

**Public**（內容公開；個人進度需登入後由另一欄位合併）

**Query**

| 參數 | 說明 |
|------|------|
| `language` | `english` \| `japanese` \| `korean` \| `all` |
| `category` | 時事、影劇、角色扮演、旅行、工作、生活… |
| `topic` | 影劇、旅行、工作、遊戲、科技… |
| `level` | 程度篩選 |
| `voice_enabled` | bool |
| `q` | 關鍵字搜尋 |
| `sort` | `recommended` \| `newest` \| `popular` \| `progress` |
| `page`, `page_size` | 分頁 |

**Response 200**：`PaginatedResponse<Scenario>`

每筆 Scenario 含：

```json
{
  "id": "jp-cafe-001",
  "title": "旅行：在咖啡廳點餐",
  "language": "japanese",
  "level": "beginner",
  "category": "旅行",
  "topic_tags": ["美食", "旅行", "日常"],
  "skill_focus": ["聽力", "跟讀", "AI 對話"],
  "estimated_minutes": 12,
  "story": "...",
  "mission": "...",
  "progress": 32,
  "is_voice_enabled": true,
  "is_saved": true,
  "source": {
    "name": "Japan National Tourism Organization",
    "url": "https://www.japan.travel/",
    "published_at": "2026-06-01",
    "status": "attribution_required",
    "summary": "...",
    "content_type": "travel"
  }
}
```

> 未登入時 `progress`、`is_saved` 為 null / false

---

### 6.2 GET `/scenarios/{scenario_id}` — 情境詳情

**Response 200**

```json
{
  "scenario": { "...": "Scenario 物件" },
  "steps": [],
  "vocabulary": [],
  "sentence_patterns": [],
  "user_progress": {
    "completed_step_id": "listening",
    "completed_step_index": 1,
    "total_steps": 8,
    "score": null,
    "last_studied_at": "2026-06-12T20:30:00+08:00"
  }
}
```

---

### 6.3 GET `/scenarios/trending` — 熱門時事情境

**Query**: `language`, `limit`（預設 6）

---

### 6.4 GET `/scenarios/recommended` — 個人化推薦

依使用者 interests、level、完成紀錄、收藏推薦。

---

### 6.5 GET `/scenarios/{scenario_id}/preview` — 情境預覽

探索頁 hover / modal 用，不含完整 steps，僅摘要資訊。

---

## 7. 學習流程模組（Learning）

> 對應 UI：情境學習頁 — 步驟進度、聽力、跟讀、我會了 / 不熟悉

### 7.1 GET `/scenarios/{scenario_id}/steps` — 取得學習步驟

**Response 200**

```json
{
  "scenario_id": "jp-cafe-001",
  "steps": [
    {
      "id": "opening",
      "title": "情境開場",
      "type": "story",
      "order_index": 0,
      "instruction": "...",
      "primary_text": "いらっしゃいませ。",
      "support_text": "Irasshaimase.",
      "translation": "歡迎光臨。",
      "audio_url": null
    }
  ],
  "current_step_id": "listening"
}
```

---

### 7.2 POST `/scenarios/{scenario_id}/steps/{step_id}/complete` — 完成步驟

**Request**

```json
{
  "result": "mastered",
  "minutes_spent": 2,
  "mistakes": []
}
```

`result`: `mastered` \| `needs_review` \| `skipped`

**Response 200**

```json
{
  "saved": true,
  "next_step_id": "understand",
  "scenario_progress": 45,
  "vocabulary_added": ["v1", "v2"]
}
```

---

### 7.3 POST `/scenarios/{scenario_id}/complete` — 完成整個情境

**Request**

```json
{
  "score": 86,
  "minutes_spent": 12,
  "mistakes": [
    { "type": "vocabulary", "item_id": "v1", "note": "發音需加強" }
  ]
}
```

**Response 200**

```json
{
  "saved": true,
  "achievement_unlocked": ["first_cafe_scenario"],
  "next_review_at": "2026-06-14T09:00:00+08:00",
  "feedback": "你現在可以在日本咖啡廳完成基本點餐。",
  "recommended_scenarios": ["jp-hotel-001"]
}
```

---

### 7.4 POST `/progress` — 儲存進度（通用）

**現有端點，保留作輕量進度更新**

**Request**

```json
{
  "scenario_id": "jp-cafe-001",
  "completed_step": "listening",
  "score": 80,
  "minutes_spent": 3
}
```

---

## 8. 複習模組（Review）

> 對應 UI：側邊欄「複習」、首頁學習捷徑

### 8.1 GET `/review` — 複習總覽

**Response 200**

```json
{
  "due_today": [],
  "sentence_patterns": [],
  "listening_count": 6,
  "mistake_count": 4,
  "summary": {
    "vocabulary_due": 128,
    "sentence_due": 24,
    "scenario_due": 3
  }
}
```

---

### 8.2 GET `/review/vocabulary` — 待複習單字

**Query**: `limit`, `language`

---

### 8.3 GET `/review/sentences` — 待複習句型

---

### 8.4 GET `/review/scenarios` — 待複習情境

間隔重複到期且未完成的情境。

---

### 8.5 POST `/review/vocabulary/{vocab_id}` — 提交單字複習結果

**Request**

```json
{
  "quality": 4
}
```

`quality`: 0-5（SM-2 演算法用，0=完全忘記，5=完美記得）

**Response 200**

```json
{
  "familiarity": 68,
  "next_review_at": "2026-06-16T09:00:00+08:00",
  "interval_days": 3
}
```

---

## 9. 單字卡模組（Vocabulary）

> 對應 UI：側邊欄「單字卡」、情境學習右側面板

### 9.1 GET `/vocabulary` — 使用者單字庫

**Query**: `language`, `scenario_id`, `sort`（`familiarity` \| `recent` \| `due`）, 分頁

---

### 9.2 GET `/vocabulary/{vocab_id}` — 單字詳情

---

### 9.3 POST `/vocabulary/{vocab_id}/favorite` — 收藏單字

---

### 9.4 DELETE `/vocabulary/{vocab_id}/favorite` — 取消收藏

---

## 10. 句子練習模組（Sentences）

> 對應 UI：側邊欄「句子練習」

### 10.1 GET `/sentences` — 句型列表

**Query**: `language`, `scenario_id`, `practice_type`

`practice_type`: `fill_blank` \| `reorder` \| `translate` \| `shadowing`

---

### 10.2 GET `/sentences/{pattern_id}` — 句型詳情與練習題

**Response 200**

```json
{
  "id": "s1",
  "pattern": "N をください",
  "explanation": "...",
  "example": "水をください。",
  "practice_prompt": "把「請給我一杯咖啡」改成日文。",
  "exercises": [
    {
      "id": "ex1",
      "type": "translate",
      "prompt": "請給我一杯咖啡",
      "hint": "使用 ください 句型"
    }
  ],
  "user_stats": {
    "attempts": 5,
    "correct_rate": 0.8,
    "next_review_at": "2026-06-15T09:00:00+08:00"
  }
}
```

---

### 10.3 POST `/sentences/{pattern_id}/practice` — 提交練習答案

**Request**

```json
{
  "exercise_id": "ex1",
  "user_answer": "コーヒーをください。",
  "practice_type": "translate"
}
```

**Response 200**

```json
{
  "correct": true,
  "expected_answer": "コーヒーをください。",
  "feedback": "句型運用正確！",
  "next_review_at": "2026-06-17T09:00:00+08:00"
}
```

---

### 10.4 GET `/sentences/due` — 今日待練習句型

---

## 11. AI 對話模組（Conversation）

> 對應 UI：AI 對話頁、首頁 AI 對話練習 widget

### 11.1 POST `/conversation/sessions` — 建立對話 session

**Request**

```json
{
  "scenario_id": "jp-cafe-001",
  "mode": "roleplay",
  "role_setting": {
    "ai_role": "咖啡店店員",
    "user_role": "旅客",
    "tone": "polite"
  }
}
```

**Response 201**

```json
{
  "session_id": "uuid",
  "opening_message": {
    "speaker": "AI 店員",
    "target_text": "いらっしゃいませ。ご注文はお決まりですか？",
    "reading": "Irasshaimase. Go-chuumon wa okimari desu ka?",
    "translation": "歡迎光臨。請問您決定好要點什麼了嗎？"
  }
}
```

---

### 11.2 POST `/conversation/sessions/{session_id}/messages` — 送出使用者訊息

**Request**

```json
{
  "user_message": "ホットコーヒーを一つください。"
}
```

**Response 200**

```json
{
  "score_delta": 5,
  "current_score": 86,
  "next_message": {
    "speaker": "AI 店員",
    "target_text": "かしこまりました。サイズはどうしますか？",
    "reading": "Kashikomarimashita. Saizu wa dou shimasu ka?",
    "translation": "好的。請問尺寸要多大呢？",
    "feedback": "你的回答很清楚，可以再加上一個禮貌結尾會更自然。"
  },
  "tips": ["語速穩定", "句型正確"],
  "is_session_complete": false,
  "turn_count": 2,
  "max_turns": 8
}
```

---

### 11.3 POST `/conversation` — 快速對話一輪（現有端點）

無 session 的簡化版，適合原型階段。Phase 2 建議改用 session 模式。

---

### 11.4 GET `/conversation/sessions/{session_id}` — 取得對話紀錄

---

### 11.5 POST `/conversation/sessions/{session_id}/complete` — 結束對話並產生報告

**Response 200**

```json
{
  "session_id": "uuid",
  "score": 86,
  "feedback": {
    "naturalness": 85,
    "grammar": 90,
    "vocabulary": 80,
    "pronunciation": null,
    "politeness": 88
  },
  "summary": "整體表現良好，敬語運用正確。",
  "strengths": ["句型運用正確", "回答簡潔清楚"],
  "improvements": ["語調可更自然", "可嘗試更口語的替代說法"],
  "recommended_review": ["N をください", "注文"]
}
```

---

### 11.6 GET `/conversation/sessions` — 對話歷史列表

**Query**: 分頁、`scenario_id`, `mode`

---

## 12. 收藏模組（Saved）

> 對應 UI：收藏頁、情境卡片書籤 icon、首頁「我的收藏」捷徑

### 12.1 GET `/saved` — 收藏列表

**Query**

| 參數 | 說明 |
|------|------|
| `type` | `scenario` \| `vocabulary` \| `sentence` \| `conversation` \| `news` |
| `language` | 語言篩選 |
| 分頁 | |

---

### 12.2 POST `/saved` — 新增收藏

**Request**

```json
{
  "item_type": "scenario",
  "item_id": "jp-cafe-001"
}
```

**Response 201**

```json
{
  "id": "uuid",
  "item_type": "scenario",
  "item_id": "jp-cafe-001",
  "created_at": "2026-06-13T10:00:00+08:00"
}
```

---

### 12.3 DELETE `/saved/{saved_id}` — 取消收藏

---

## 13. 進度分析模組（Analytics）

> 對應 UI：進度分析頁、首頁學習分析 widget

### 13.1 GET `/analytics/overview` — 總覽

**Query**: `language`, `period`（`7d` \| `30d` \| `90d` \| `all`）

**Response 200**

```json
{
  "period": "30d",
  "total_minutes": 420,
  "scenarios_completed": 12,
  "vocabulary_learned": 86,
  "conversation_sessions": 8,
  "average_score": 82,
  "streak_days": 7,
  "best_streak_days": 14,
  "skill_breakdown": {
    "listening": 78,
    "speaking": 72,
    "reading": 85,
    "vocabulary": 80,
    "grammar": 76
  }
}
```

---

### 13.2 GET `/analytics/skills` — 技能成長趨勢

**Response 200**

```json
{
  "period": "30d",
  "data_points": [
    { "date": "2026-06-01", "listening": 70, "speaking": 65 },
    { "date": "2026-06-02", "listening": 72, "speaking": 68 }
  ]
}
```

---

### 13.3 GET `/analytics/weaknesses` — 弱點分析

**Response 200**

```json
{
  "weaknesses": [
    {
      "area": "敬語運用",
      "score": 62,
      "related_vocabulary": ["v2"],
      "related_patterns": ["s1"],
      "recommended_scenarios": ["jp-cafe-001"]
    }
  ]
}
```

---

### 13.4 GET `/analytics/report/{session_id}` — 單次對話 / 學習詳細報告

---

## 14. 搜尋模組（Search）

> 對應 UI：頂部搜尋列

### 14.1 GET `/search` — 全域搜尋

**Query**

| 參數 | 說明 |
|------|------|
| `q` | 搜尋關鍵字（必填） |
| `type` | `all` \| `scenario` \| `vocabulary` \| `sentence` |
| `language` | 語言 |
| 分頁 | |

**Response 200**

```json
{
  "query": "咖啡廳",
  "results": {
    "scenarios": [],
    "vocabulary": [],
    "sentences": []
  },
  "total": 15
}
```

---

### 14.2 GET `/search/suggestions` — 搜尋建議

**Query**: `q`（至少 2 字）

---

## 15. 通知模組（Notifications）

> 對應 UI：頂部鈴鐺 icon

### 15.1 GET `/notifications` — 通知列表

**Query**: 分頁、`unread_only`

---

### 15.2 PATCH `/notifications/{id}/read` — 標記已讀

---

### 15.3 POST `/notifications/read-all` — 全部標記已讀

---

## 16. 語音模組（Speech）— Phase 3

### 16.1 POST `/speech/evaluate` — 發音評分

**Request**: `multipart/form-data`

| 欄位 | 說明 |
|------|------|
| `audio` | 錄音檔 |
| `reference_text` | 目標文本 |
| `language` | 語言 |

**Response 200**

```json
{
  "score": 78,
  "pronunciation_score": 80,
  "fluency_score": 75,
  "feedback": "尾音略短，建議延長「す」的長度。",
  "word_scores": []
}
```

---

### 16.2 GET `/speech/tts` — 文字轉語音

**Query**: `text`, `language`, `speed`

回傳 audio URL 或 stream。

---

## 17. 內容管理模組（Content）— Phase 4

> 後台 CMS，第一版不做 UI，但 API 預留

| Method | Path | 說明 |
|--------|------|------|
| POST | `/content/scenarios` | 建立情境 |
| PATCH | `/content/scenarios/{id}` | 更新情境 |
| POST | `/content/import` | 批次匯入 |
| GET | `/content/sources` | 來源管理 |

需 Admin 角色。

---

## 18. 健康檢查

### GET `/health`

**Public**

**Response 200**

```json
{
  "status": "ok",
  "service": "learnflow",
  "database": "connected",
  "version": "0.1.0"
}
```

---

## 19. 實作路線圖

### Phase 2a — 認證與使用者（Week 1-2）

```
POST /auth/register
POST /auth/login
POST /auth/refresh
GET  /users/me
PATCH /users/me/preferences
```

### Phase 2b — 核心學習（Week 3-4）

```
GET  /dashboard (+ calendar, daily-tasks)
GET  /scenarios (+ trending, recommended)
GET  /scenarios/{id}
POST /progress
POST /scenarios/{id}/steps/{step_id}/complete
GET  /review (+ vocabulary, sentences)
POST /review/vocabulary/{id}
```

### Phase 2c — 互動與收藏（Week 5-6）

```
POST /conversation/sessions
POST /conversation/sessions/{id}/messages
POST /conversation/sessions/{id}/complete
GET/POST/DELETE /saved
GET  /vocabulary
GET  /sentences
POST /sentences/{id}/practice
```

### Phase 3 — AI 與語音

```
POST /speech/evaluate
GET  /speech/tts
（conversation 改接真實 LLM provider）
```

### Phase 4 — 推薦與 CMS

```
GET  /search
GET  /analytics/*
POST /content/*
（pgvector 語意搜尋）
```

---

## 20. 前端頁面與 API 對照

| 頁面 / 區塊 | 主要 API |
|-------------|----------|
| 登入頁 | `POST /auth/login`, `GET /auth/google` |
| 註冊 | `POST /auth/register` |
| 忘記密碼 | `POST /auth/forgot-password` |
| 首頁 — 今日進度 | `GET /dashboard` |
| 首頁 — 繼續學習 | `GET /dashboard` → `current_scenario` |
| 首頁 — 推薦課程 | `GET /dashboard` → `recommended_scenarios` |
| 首頁 — 學習捷徑 | `GET /dashboard` → `shortcuts` |
| 首頁 — 學習日曆 | `GET /dashboard/calendar` |
| 首頁 — AI 對話練習 | `GET /dashboard` → `ai_chat_preview` |
| 首頁 — 學習分析 | `GET /dashboard` → `analysis_summary` |
| 學習探索 | `GET /scenarios` |
| 情境學習 | `GET /scenarios/{id}`, `POST .../steps/{id}/complete` |
| AI 對話 | `POST /conversation/sessions`, `.../messages` |
| 複習 | `GET /review`, `POST /review/vocabulary/{id}` |
| 單字卡 | `GET /vocabulary` |
| 句子練習 | `GET /sentences`, `POST /sentences/{id}/practice` |
| 進度分析 | `GET /analytics/overview` |
| 收藏 | `GET /saved`, `POST /saved`, `DELETE /saved/{id}` |
| 設定 | `PATCH /users/me/preferences` |
| 頂部搜尋 | `GET /search` |
| 通知 | `GET /notifications` |

---

## 21. 安全考量

| 項目 | 作法 |
|------|------|
| 密碼 | bcrypt / argon2 雜湊，最少 8 字元 |
| JWT | access 1h + refresh 30d，refresh 存 DB 可撤銷 |
| OAuth | Google OAuth 2.0，state 防 CSRF |
| Rate Limit | 登入 5/min/IP；AI 對話 30/min/user |
| CORS | 生產環境限制 origin |
| 輸入驗證 | Pydantic schema 嚴格驗證 |
| SQL | 參數化查詢，禁止字串拼接 |

---

## 22. 附錄：OpenAPI Tag 分組

```yaml
tags:
  - name: Auth
  - name: User
  - name: Dashboard
  - name: Scenarios
  - name: Learning
  - name: Review
  - name: Vocabulary
  - name: Sentences
  - name: Conversation
  - name: Saved
  - name: Analytics
  - name: Search
  - name: Notifications
  - name: Speech
  - name: Content
  - name: Health
```

FastAPI 自動產生 Swagger UI：`http://127.0.0.1:8002/docs`
