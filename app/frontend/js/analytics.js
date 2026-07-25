/**
 * 進度分析 — 懶人追蹤 + 深度數據（全自動彙整）
 * 依賴 app.js 全域：el, clear, viewRoot, render, navigateTo
 * 依賴 auth.js 全域：authFetch, AUTH_API
 *
 * 圖表設計依 dataviz 方法：色彩最後、經驗證；
 *  - 熱力圖 / 學習狀態：單一藍色「順序」色階（light→dark），非分類多色
 *  - 評分分佈：沿用複習頁的序數評分色（Again→Easy），每條皆直接標示數字（色彩非唯一編碼）
 *  - 成長曲線：單一數列、2px 線、末端直接標值（無需圖例）
 *  - 文字一律用墨色 token，不用數列色
 */

const analyticsState = { loading: false, error: "", data: null };

// 順序藍色階（熱力圖 5 段：空 / 低→高）
const HEAT_RAMP = ["#eef3fb", "#cfe0fb", "#93baf5", "#5b93f0", "#2f75ed"];
// 學習狀態：單一藍 hue 順序色階（light→dark），配直接標籤
const STATE_RAMP = { new: "#dbe8fd", learning: "#9dc0f7", review: "#2f75ed", relearning: "#5b93f0" };
const STATE_LABEL = { new: "待學", learning: "學習中", review: "已掌握", relearning: "重新學習" };
// 評分：序數（差→好），沿用複習頁色
const RATING_COLOR = { again: "#ef5757", hard: "#f7a928", good: "#2f75ed", easy: "#17b890" };
const RATING_LABEL = { again: "再一次", hard: "困難", good: "良好", easy: "簡單" };

const SVGNS = "http://www.w3.org/2000/svg";
function svg(tag, attrs) {
  const node = document.createElementNS(SVGNS, tag);
  if (attrs) for (const k in attrs) node.setAttribute(k, attrs[k]);
  return node;
}

async function analyticsOnEnter() {
  await loadAnalytics();
  render();
}

async function loadAnalytics() {
  analyticsState.loading = true;
  analyticsState.error = "";
  render();
  try {
    const res = await authFetch(`${AUTH_API}/analytics/overview`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    analyticsState.data = await res.json();
  } catch (err) {
    analyticsState.error = err.message || "無法載入進度分析";
  } finally {
    analyticsState.loading = false;
  }
}

function statTile(value, label, hint) {
  const tile = el("div", "stat-tile");
  tile.appendChild(el("div", "stat-value", value));
  tile.appendChild(el("div", "stat-label", label));
  if (hint) tile.appendChild(el("div", "stat-hint", hint));
  return tile;
}

function heatBucket(count) {
  if (!count) return 0;
  if (count <= 2) return 1;
  if (count <= 5) return 2;
  if (count <= 9) return 3;
  return 4;
}

function renderHeatmap(daily) {
  const byDate = {};
  daily.forEach((d) => (byDate[d.date] = d.count));

  const WEEKS = 18;
  const DAYS = WEEKS * 7;
  const today = new Date();
  const start = new Date(today);
  start.setDate(start.getDate() - (DAYS - 1));
  // 對齊到週日
  start.setDate(start.getDate() - start.getDay());

  const cell = 13;
  const gap = 3;
  const cols = Math.ceil((DAYS + today.getDay() + 1) / 7) + 1;
  const width = cols * (cell + gap) + 20;
  const height = 7 * (cell + gap) + 20;
  const s = svg("svg", { viewBox: `0 0 ${width} ${height}`, class: "heatmap-svg", role: "img" });

  const cursor = new Date(start);
  for (let c = 0; c < cols; c++) {
    for (let r = 0; r < 7; r++) {
      if (cursor > today) break;
      const iso = cursor.toISOString().slice(0, 10);
      const count = byDate[iso] || 0;
      const rect = svg("rect", {
        x: c * (cell + gap) + 4,
        y: r * (cell + gap) + 4,
        width: cell,
        height: cell,
        rx: 3,
        fill: HEAT_RAMP[heatBucket(count)],
      });
      const t = svg("title");
      t.textContent = `${iso}：${count} 次複習`;
      rect.appendChild(t);
      s.appendChild(rect);
      cursor.setDate(cursor.getDate() + 1);
    }
  }
  return s;
}

function renderBars(breakdown) {
  const keys = ["again", "hard", "good", "easy"];
  const max = Math.max(1, ...keys.map((k) => breakdown[k]));
  const wrap = el("div", "bar-chart");
  keys.forEach((k) => {
    const row = el("div", "bar-row");
    row.appendChild(el("span", "bar-name", RATING_LABEL[k]));
    const track = el("div", "bar-track");
    const fill = el("div", "bar-fill");
    fill.style.width = `${(breakdown[k] / max) * 100}%`;
    fill.style.background = RATING_COLOR[k];
    fill.title = `${RATING_LABEL[k]}：${breakdown[k]} 次`;
    track.appendChild(fill);
    row.appendChild(track);
    row.appendChild(el("span", "bar-value", String(breakdown[k])));
    wrap.appendChild(row);
  });
  return wrap;
}

function renderStateBar(states) {
  const order = ["new", "learning", "relearning", "review"];
  const total = order.reduce((a, k) => a + states[k], 0);
  const wrap = el("div", "state-block");
  const bar = el("div", "state-bar");
  if (total === 0) {
    bar.appendChild(el("div", "state-empty", ""));
  } else {
    order.forEach((k) => {
      if (!states[k]) return;
      const seg = el("div", "state-seg");
      seg.style.width = `${(states[k] / total) * 100}%`;
      seg.style.background = STATE_RAMP[k];
      seg.title = `${STATE_LABEL[k]}：${states[k]}`;
      bar.appendChild(seg);
    });
  }
  wrap.appendChild(bar);

  const legend = el("div", "state-legend");
  order.forEach((k) => {
    const item = el("div", "state-legend-item");
    const dot = el("span", "state-dot");
    dot.style.background = STATE_RAMP[k];
    item.appendChild(dot);
    item.appendChild(el("span", null, `${STATE_LABEL[k]} ${states[k]}`));
    legend.appendChild(item);
  });
  wrap.appendChild(legend);
  return wrap;
}

function renderGrowth(growth) {
  if (!growth.length) {
    return el("p", "muted", "尚無資料。");
  }
  const W = 640;
  const H = 200;
  const padL = 34;
  const padB = 22;
  const padT = 10;
  const padR = 40;
  const maxY = Math.max(1, ...growth.map((g) => g.cumulative));
  const n = growth.length;
  const x = (i) => padL + (n === 1 ? 0 : (i / (n - 1)) * (W - padL - padR));
  const y = (v) => padT + (1 - v / maxY) * (H - padT - padB);

  const s = svg("svg", { viewBox: `0 0 ${W} ${H}`, class: "growth-svg", role: "img" });

  // 淺色格線（recessive）
  [0, 0.5, 1].forEach((f) => {
    const gy = padT + f * (H - padT - padB);
    s.appendChild(svg("line", { x1: padL, y1: gy, x2: W - padR, y2: gy, stroke: "#e4e9f2", "stroke-width": 1 }));
    const lbl = svg("text", { x: 4, y: gy + 4, class: "chart-axis-text" });
    lbl.textContent = String(Math.round(maxY * (1 - f)));
    s.appendChild(lbl);
  });

  const pts = growth.map((g, i) => `${x(i)},${y(g.cumulative)}`).join(" ");
  s.appendChild(svg("polyline", { points: pts, fill: "none", stroke: "#2f75ed", "stroke-width": 2, "stroke-linecap": "round", "stroke-linejoin": "round" }));

  // 末端直接標值
  const last = growth[n - 1];
  const cx = x(n - 1);
  const cy = y(last.cumulative);
  s.appendChild(svg("circle", { cx, cy, r: 4, fill: "#2f75ed" }));
  const val = svg("text", { x: Math.min(cx + 6, W - 4), y: cy - 6, class: "chart-end-label" });
  val.textContent = String(last.cumulative);
  s.appendChild(val);

  return s;
}

function analyticsCard(title, subtitle, body) {
  const card = el("section", "analytics-card");
  const head = el("div", "analytics-card-head");
  head.appendChild(el("h2", null, title));
  if (subtitle) head.appendChild(el("span", "analytics-card-sub", subtitle));
  card.appendChild(head);
  card.appendChild(body);
  return card;
}

function renderAnalyticsView() {
  clear(viewRoot);
  const page = el("div", "analytics-page");
  viewRoot.appendChild(page);

  const header = el("header", "analytics-header");
  header.appendChild(el("h1", null, "進度分析"));
  header.appendChild(el("p", null, "全自動追蹤你的學習與記憶曲線，無需手動記錄。"));
  page.appendChild(header);

  if (analyticsState.loading) {
    const p = el("section", "panel");
    p.appendChild(el("p", "muted", "載入分析中…"));
    page.appendChild(p);
    return;
  }
  if (analyticsState.error) {
    const p = el("section", "panel favorites-setup-error");
    p.appendChild(el("h2", null, "無法載入進度分析"));
    p.appendChild(el("p", "muted", analyticsState.error));
    p.appendChild(el("p", "muted", "若剛建立資料表：請執行 spec/database/002_srs.sql，並重啟後端。"));
    page.appendChild(p);
    return;
  }

  const d = analyticsState.data;
  const k = d.kpis;

  if (k.total_cards === 0 && k.reviews_total === 0) {
    const empty = el("section", "panel favorites-empty");
    empty.appendChild(el("h2", null, "還沒有學習數據"));
    empty.appendChild(el("p", "muted", "用 Chrome 擴充在 YouTube 收藏單字，或在課程中收藏內容並開始複習，這裡就會出現你的記憶曲線與統計。"));
    const btn = el("button", "primary-button", "前往複習");
    btn.type = "button";
    btn.addEventListener("click", () => navigateTo("review"));
    empty.appendChild(btn);
    page.appendChild(empty);
    return;
  }

  // KPI tiles
  const tiles = el("div", "stat-grid");
  tiles.appendChild(statTile(`${k.streak_days}`, "連續學習（天）", "有複習的日子"));
  tiles.appendChild(statTile(`${k.due_today}`, "待複習", "今日到期"));
  tiles.appendChild(
    statTile(k.retention == null ? "—" : `${Math.round(k.retention * 100)}%`, "記憶保留率", "近 30 天"),
  );
  tiles.appendChild(statTile(`${k.known_cards}`, "已掌握單字", "review 階段"));
  tiles.appendChild(statTile(`${k.reviews_total}`, "累計複習", `今日 ${k.reviews_today}`));
  tiles.appendChild(statTile(`${k.captures_total}`, "YouTube 收藏", "擴充擷取"));
  page.appendChild(tiles);

  // 熱力圖
  page.appendChild(
    analyticsCard("複習熱力圖", "近 18 週每日複習量", (() => {
      const wrap = el("div", "chart-scroll");
      wrap.appendChild(renderHeatmap(d.daily_reviews));
      const legend = el("div", "heat-legend");
      legend.appendChild(el("span", "muted", "少"));
      HEAT_RAMP.slice(1).forEach((c) => {
        const box = el("span", "heat-legend-box");
        box.style.background = c;
        legend.appendChild(box);
      });
      legend.appendChild(el("span", "muted", "多"));
      wrap.appendChild(legend);
      return wrap;
    })()),
  );

  // 評分分佈 + 學習狀態（並排）
  const twoCol = el("div", "analytics-two-col");
  twoCol.appendChild(analyticsCard("評分分佈", "近 30 天", renderBars(d.rating_breakdown)));
  twoCol.appendChild(analyticsCard("學習狀態", `共 ${k.total_cards} 張卡`, renderStateBar(d.cards_by_state)));
  page.appendChild(twoCol);

  // 成長曲線
  page.appendChild(
    analyticsCard("單字量成長", "累計收藏 / 學習項目", (() => {
      const wrap = el("div", "chart-scroll");
      wrap.appendChild(renderGrowth(d.vocab_growth));
      return wrap;
    })()),
  );

  // 情境課程作答（若有）
  if (d.lesson_attempts.total > 0) {
    const acc = Math.round((d.lesson_attempts.correct / d.lesson_attempts.total) * 100);
    const body = el("p", "muted", `已作答 ${d.lesson_attempts.total} 題，答對率 ${acc}%。`);
    page.appendChild(analyticsCard("情境課程練習", "步驟機作答", body));
  }
}

window.learnflowAnalytics = {
  onEnter: analyticsOnEnter,
  renderView: renderAnalyticsView,
};
