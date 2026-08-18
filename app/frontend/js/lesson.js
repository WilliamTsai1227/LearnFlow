/**
 * 學習流程步驟機 — 盲聽 → 逐句 → 聽力驗證 → 跟讀 → 靈活應用 → 寫 → 結算
 * 規格：spec/document/LEARNING_FLOW_SPEC.md
 *
 * 依賴 app.js 的全域工具（el、showToast、createSvgIcon、playAudioUrl、
 * createFavoriteButton、isSentenceSaved、isVocabularySaved、state、render）。
 * 本檔在 app.js 之後載入。
 */

const LESSON_API = resolveLearnFlowApiBase();

const lessonAudio = new Audio();

const lessonState = {
  loading: false,
  error: "",
  scenarioId: null,
  courseId: null,
  lesson: null,
  stepIndex: 0,
  maxStepReached: 0,
  resume: null,
  rt: {},
  attempts: [],
  resultSent: false,
  sequence: { playing: false, paused: false, index: 0, urls: [], onUpdate: null, onDone: null },
};

const STEP_SKILLS = {
  blind_listen: "listening",
  listen_check: "listening",
  apply: "reading",
  write: "writing",
};

const SKILL_LABELS = {
  listening: "聽",
  reading: "讀・用",
  writing: "寫",
};

function lessonRt(stepIndex) {
  if (!lessonState.rt[stepIndex]) lessonState.rt[stepIndex] = {};
  return lessonState.rt[stepIndex];
}

function lessonSteps() {
  return lessonState.lesson ? lessonState.lesson.steps : [];
}

function currentLessonStep() {
  return lessonSteps()[lessonState.stepIndex] || null;
}

function lessonSentenceById(id) {
  return lessonState.lesson.course.sentences.find((row) => row.id === id) || null;
}

// ---------------------------------------------------------------------------
// 進度與作答持久化
// ---------------------------------------------------------------------------

async function lessonAuthRequest(path, options = {}) {
  try {
    const response = await authFetch(`${LESSON_API}${path}`, options);
    if (!response || !response.ok) return null;
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

function persistLessonProgress(extra = {}) {
  if (!lessonState.courseId) return;
  lessonAuthRequest(`/lesson/progress/${encodeURIComponent(lessonState.courseId)}`, {
    method: "PUT",
    body: JSON.stringify({ current_step: lessonState.maxStepReached, ...extra }),
  });
}

function recordLessonAttempt(step, exercise, isCorrect) {
  lessonState.attempts.push({
    step_type: step.type,
    exercise_kind: exercise.kind,
    item_type: exercise.item_type || null,
    item_id: exercise.item_id || null,
    is_correct: isCorrect,
  });
}

function lessonScore() {
  const total = lessonState.attempts.length;
  if (!total) return { percent: 0, total: 0, bySkill: {} };
  const bySkill = {};
  let correct = 0;
  lessonState.attempts.forEach((attempt) => {
    const skill = STEP_SKILLS[attempt.step_type] || "reading";
    if (!bySkill[skill]) bySkill[skill] = { correct: 0, total: 0 };
    bySkill[skill].total += 1;
    if (attempt.is_correct) {
      bySkill[skill].correct += 1;
      correct += 1;
    }
  });
  return { percent: Math.round((correct / total) * 100), total, bySkill };
}

async function submitLessonResult() {
  if (lessonState.resultSent) return;
  lessonState.resultSent = true;

  const { percent } = lessonScore();
  persistLessonProgress({ completed: true, score: percent });

  if (lessonState.attempts.length) {
    lessonAuthRequest("/lesson/attempts", {
      method: "POST",
      body: JSON.stringify({
        course_id: lessonState.courseId,
        attempts: lessonState.attempts,
      }),
    });
  }
}

// ---------------------------------------------------------------------------
// 音檔
// ---------------------------------------------------------------------------

function lessonPlayUrl(url) {
  stopLessonSequence();
  if (!url) {
    showToast("此句尚未提供語音檔。", { type: "warning" });
    return;
  }
  lessonAudio.src = learnflowAudioUrl(url);
  lessonAudio.play().catch(() => {
    showToast("語音檔尚未準備好，請稍後再試。", { type: "warning" });
  });
}

/** 完全停止：重設回第一句（再按播放會從頭開始）。 */
function stopLessonSequence() {
  lessonState.sequence.playing = false;
  lessonState.sequence.paused = false;
  lessonState.sequence.index = 0;
  lessonAudio.onended = null;
  lessonAudio.pause();
}

/** 暫停：保留目前句子的位置（再按播放會重念這一句，再順著往下）。 */
function pauseLessonSequence() {
  lessonState.sequence.playing = false;
  lessonState.sequence.paused = true;
  lessonAudio.onended = null;
  lessonAudio.pause();
}

/** 內部：從 sequence.index 開始依序播放。 */
function runLessonSequence() {
  const seq = lessonState.sequence;
  if (!seq.playing || seq.index >= seq.urls.length) {
    seq.playing = false;
    seq.paused = false;
    seq.index = 0; // 播完自然結束 → 下次從頭
    lessonAudio.onended = null;
    if (seq.onDone) seq.onDone();
    return;
  }
  const url = seq.urls[seq.index];
  if (seq.onUpdate) seq.onUpdate(seq.index);
  lessonAudio.src = learnflowAudioUrl(url);
  lessonAudio.onended = () => {
    seq.index += 1;
    runLessonSequence();
  };
  lessonAudio.play().catch(() => {
    seq.playing = false;
    seq.paused = false;
    lessonAudio.onended = null;
    showToast("語音檔播放失敗，請稍後再試。", { type: "warning" });
    if (seq.onDone) seq.onDone();
  });
}

function playLessonSequence(urls, onUpdate, onDone) {
  stopLessonSequence();
  lessonState.sequence = {
    playing: true,
    paused: false,
    index: 0,
    urls,
    onUpdate,
    onDone,
  };
  runLessonSequence();
}

/** 從暫停處續播：會把「暫停時那一句」重念一次，再往下播。 */
function resumeLessonSequence() {
  const seq = lessonState.sequence;
  if (!seq.urls || !seq.urls.length) return;
  seq.playing = true;
  seq.paused = false;
  runLessonSequence();
}

// ---------------------------------------------------------------------------
// 入口與步驟推進
// ---------------------------------------------------------------------------

async function startLesson(scenarioId, courseId) {
  stopLessonSequence();
  Object.assign(lessonState, {
    loading: true,
    error: "",
    scenarioId,
    courseId,
    lesson: null,
    stepIndex: 0,
    maxStepReached: 0,
    resume: null,
    rt: {},
    attempts: [],
    resultSent: false,
  });
  state.view = "lesson";
  render();

  try {
    const lesson = await api(
      `/api/scenarios/${encodeURIComponent(scenarioId)}/courses/${encodeURIComponent(courseId)}/lesson`,
    );
    lessonState.lesson = lesson;
    lessonState.resume = await lessonAuthRequest(
      `/lesson/progress/${encodeURIComponent(courseId)}`,
    );
  } catch (error) {
    lessonState.error = error.message || "無法載入課程";
  } finally {
    lessonState.loading = false;
  }
  render();
  scrollViewToTop();
}

function gotoLessonStep(index) {
  const steps = lessonSteps();
  if (index < 0 || index >= steps.length) return;
  if (index > lessonState.maxStepReached) return;
  stopLessonSequence();
  lessonState.stepIndex = index;
  render();
  scrollViewToTop();
}

function completeLessonStep() {
  const steps = lessonSteps();
  const next = Math.min(lessonState.stepIndex + 1, steps.length - 1);
  stopLessonSequence();
  lessonState.maxStepReached = Math.max(lessonState.maxStepReached, next);
  lessonState.stepIndex = next;
  persistLessonProgress();
  if (steps[next] && steps[next].type === "result") {
    submitLessonResult();
  }
  render();
  scrollViewToTop();
}

async function exitLessonToScenario() {
  stopLessonSequence();
  try {
    await loadScenarioDetail(lessonState.scenarioId);
    state.view = "scenario";
  } catch (error) {
    state.view = "learn";
    state.errorMessage = error.message;
  }
  render();
}

async function openLessonBrowseMode() {
  stopLessonSequence();
  try {
    await loadCourseDetail(lessonState.scenarioId, lessonState.courseId);
    state.view = "course";
    render();
  } catch (error) {
    showToast(error.message || "無法開啟課程", { type: "warning" });
  }
}

// ---------------------------------------------------------------------------
// 共用 UI 元件
// ---------------------------------------------------------------------------

function lessonPlayIconButton(label, onClick, options = {}) {
  const button = el("button", `lesson-play-btn${options.big ? " lesson-play-big" : ""}`);
  button.type = "button";
  button.appendChild(createSvgIcon(options.icon || ["M6 4l14 8-14 8z"], options.big ? 22 : 16));
  if (label) button.appendChild(document.createTextNode(label));
  button.addEventListener("click", onClick);
  return button;
}

// 播放控制用的圖示
const ICON_PLAY = ["M6 4l14 8-14 8z"];
const ICON_PAUSE = ["M9 5v14", "M15 5v14"];
const ICON_STOP = ["M6 6h12v12H6z"];

function lessonContinueButton(enabled, label = "下一步") {
  const wrap = el("div", "lesson-flow-continue");
  const button = el("button", "primary-button lesson-continue-btn", label);
  button.type = "button";
  button.disabled = !enabled;
  button.addEventListener("click", completeLessonStep);
  wrap.appendChild(button);
  return wrap;
}

function lessonFeedbackBanner(correct, correctText) {
  const banner = el(
    "div",
    `lesson-feedback ${correct ? "is-correct" : "is-wrong"}`,
  );
  banner.appendChild(
    el("strong", null, correct ? "答對了！" : "再想想 — 正確答案："),
  );
  if (!correct && correctText) {
    banner.appendChild(el("span", "lesson-feedback-answer", correctText));
  }
  return banner;
}

// ---------------------------------------------------------------------------
// 選擇題（盲聽 / 聽力驗證共用）
// ---------------------------------------------------------------------------

function renderLessonQuiz(container, step, quiz, options = {}) {
  const rt = lessonRt(step.step_index);
  if (!rt.answers) {
    rt.answers = {};
    rt.current = 0;
  }
  const index = rt.current;
  const done = index >= quiz.length;

  const progress = el("p", "lesson-quiz-progress");
  progress.textContent = done
    ? `已完成 ${quiz.length} 題`
    : `第 ${index + 1} / ${quiz.length} 題`;
  container.appendChild(progress);

  if (done) {
    const correctCount = Object.values(rt.answers).filter((a) => a.correct).length;
    const summary = el("div", "lesson-quiz-summary");
    summary.appendChild(
      el("p", null, `答對 ${correctCount} / ${quiz.length} 題`),
    );
    container.appendChild(summary);
    return true;
  }

  const question = quiz[index];
  const answered = rt.answers[index];

  const card = el("div", "lesson-quiz-card");
  card.appendChild(el("p", "lesson-quiz-prompt", question.prompt));

  if (question.audio_url) {
    card.appendChild(
      lessonPlayIconButton("播放音檔", () => lessonPlayUrl(question.audio_url), {
        big: true,
      }),
    );
  }

  const optionList = el("div", "lesson-quiz-options");
  question.options.forEach((option) => {
    let className = "lesson-quiz-option";
    if (answered) {
      if (option.id === question.answer_id) className += " is-correct";
      else if (option.id === answered.selectedId) className += " is-wrong";
      className += " is-locked";
    }
    const button = el("button", className, option.text);
    button.type = "button";
    button.disabled = Boolean(answered);
    button.addEventListener("click", () => {
      const correct = option.id === question.answer_id;
      rt.answers[index] = { selectedId: option.id, correct };
      recordLessonAttempt(step, question, correct);
      render();
    });
    optionList.appendChild(button);
  });
  card.appendChild(optionList);

  if (answered) {
    const correctOption = question.options.find(
      (option) => option.id === question.answer_id,
    );
    card.appendChild(
      lessonFeedbackBanner(answered.correct, correctOption ? correctOption.text : ""),
    );
    if (options.revealSentence && question.item_id) {
      const sentence = lessonSentenceById(question.item_id);
      if (sentence) {
        const reveal = el("div", "lesson-quiz-reveal");
        reveal.appendChild(el("p", "lesson-quiz-reveal-text", sentence.target_text));
        if (sentence.romaji) {
          reveal.appendChild(el("p", "lesson-quiz-reveal-reading", sentence.romaji));
        }
        card.appendChild(reveal);
      }
    }
    const nextBtn = el(
      "button",
      "primary-button lesson-quiz-next",
      index + 1 < quiz.length ? "下一題" : "完成作答",
    );
    nextBtn.type = "button";
    nextBtn.addEventListener("click", () => {
      rt.current += 1;
      render();
    });
    card.appendChild(nextBtn);
  }

  container.appendChild(card);
  return false;
}

// ---------------------------------------------------------------------------
// 各步驟渲染
// ---------------------------------------------------------------------------

function renderMissionStep(container, step) {
  const data = step.data;
  const card = el("section", "lesson-mission panel");
  card.appendChild(el("p", "lesson-eyebrow", data.scenario_title));
  card.appendChild(el("h2", null, lessonState.lesson.course.title));
  card.appendChild(el("p", "lesson-mission-story", data.story));

  const chips = el("div", "lesson-mission-chips");
  [
    `${data.objectives.sentence_count} 句對話`,
    `${data.objectives.vocabulary_count} 個單字`,
    `約 ${data.objectives.estimated_minutes} 分鐘`,
  ].forEach((text) => chips.appendChild(el("span", "tag blue", text)));
  card.appendChild(chips);

  card.appendChild(
    el(
      "p",
      "lesson-mission-hint",
      "流程：單字預習 → 先聽（不看字）→ 逐句理解 → 聽力驗證 → 開口跟讀 → 靈活應用 → 寫。每一步都很短，跟著走就好。",
    ),
  );

  const resume = lessonState.resume;
  const steps = lessonSteps();
  if (resume && resume.current_step > 0 && !resume.completed) {
    const banner = el("div", "lesson-resume-banner");
    banner.appendChild(
      el("span", null, `上次學到步驟 ${resume.current_step + 1}，可以直接繼續。`),
    );
    const resumeBtn = el("button", "ghost-button", "從上次步驟繼續");
    resumeBtn.type = "button";
    resumeBtn.addEventListener("click", () => {
      const target = Math.min(resume.current_step, steps.length - 1);
      lessonState.maxStepReached = Math.max(lessonState.maxStepReached, target);
      gotoLessonStep(target);
    });
    banner.appendChild(resumeBtn);
    card.appendChild(banner);
  }

  container.appendChild(card);
  container.appendChild(lessonContinueButton(true, "開始任務"));
}

function renderVocabPreviewStep(container, step) {
  const rt = lessonRt(step.step_index);
  const vocab = lessonState.lesson.course.vocabulary;
  if (!rt.seen) {
    rt.seen = new Set();
    rt.index = 0;
    rt.showMeaning = false;
  }
  rt.seen.add(rt.index);
  const item = vocab[rt.index];

  const card = el("section", "panel lesson-step-panel");
  const header = el("div", "lesson-study-header");
  header.appendChild(el("h2", null, "單字預習"));
  header.appendChild(
    el("span", "lesson-quiz-progress", `${rt.seen.size} / ${vocab.length} 字`),
  );
  card.appendChild(header);
  card.appendChild(
    el(
      "p",
      "muted",
      "先認識這堂課會用到的單字。看到單字先想想中文意思，再點開對答案。",
    ),
  );

  const flashcard = el("div", "lesson-flashcard");

  const front = el("div", "lesson-flashcard-front");
  front.appendChild(el("div", "lesson-flashcard-term", item.term));
  if (item.romaji) {
    front.appendChild(el("p", "lesson-flashcard-romaji", item.romaji));
  }
  if (item.reading && item.reading !== item.term) {
    front.appendChild(el("p", "lesson-flashcard-reading", item.reading));
  }
  flashcard.appendChild(front);

  if (item.audio_url) {
    flashcard.appendChild(
      lessonPlayIconButton("播放單字", () => lessonPlayUrl(item.audio_url), {
        big: true,
      }),
    );
  }

  const revealRow = el("div", "lesson-flashcard-reveal");
  const revealBtn = el(
    "button",
    `translation-toggle ${rt.showMeaning ? "is-visible" : ""}`,
    rt.showMeaning ? "隱藏中文" : "顯示中文",
  );
  revealBtn.type = "button";
  revealBtn.addEventListener("click", () => {
    rt.showMeaning = !rt.showMeaning;
    render();
  });
  revealRow.appendChild(revealBtn);
  if (rt.showMeaning) {
    revealRow.appendChild(el("p", "lesson-flashcard-meaning", item.meaning));
    if (item.example_sentence) {
      revealRow.appendChild(
        el("p", "lesson-flashcard-example", item.example_sentence),
      );
    }
  }
  flashcard.appendChild(revealRow);

  const actions = el("div", "lesson-actions lesson-flashcard-actions");
  actions.appendChild(
    createFavoriteButton({
      itemType: "vocabulary",
      itemId: item.id,
      isSaved: isVocabularySaved(item.id),
      compact: true,
    }),
  );
  if (rt.index > 0) {
    const prev = el("button", "lesson-btn lesson-btn-secondary", "上一個");
    prev.type = "button";
    prev.addEventListener("click", () => {
      rt.index -= 1;
      rt.showMeaning = false;
      render();
    });
    actions.appendChild(prev);
  }
  if (rt.index < vocab.length - 1) {
    const next = el("button", "lesson-btn lesson-btn-primary", "下一個");
    next.type = "button";
    next.addEventListener("click", () => {
      rt.index += 1;
      rt.showMeaning = false;
      render();
    });
    actions.appendChild(next);
  }
  flashcard.appendChild(actions);
  card.appendChild(flashcard);

  const dots = el("div", "lesson-flashcard-dots");
  vocab.forEach((_, index) => {
    const dot = el(
      "button",
      `lesson-flashcard-dot ${index === rt.index ? "is-active" : ""}${rt.seen.has(index) ? " is-seen" : ""}`,
    );
    dot.type = "button";
    dot.setAttribute("aria-label", `第 ${index + 1} 個單字`);
    dot.addEventListener("click", () => {
      rt.index = index;
      rt.showMeaning = false;
      render();
    });
    dots.appendChild(dot);
  });
  card.appendChild(dots);

  container.appendChild(card);

  const allSeen = rt.seen.size >= vocab.length;
  container.appendChild(lessonContinueButton(allSeen));
  if (!allSeen) {
    container.appendChild(
      el("p", "lesson-step-lock-hint", "看完全部單字卡後即可前往下一步。"),
    );
  }
}

function renderBlindListenStep(container, step) {
  const data = step.data;
  const rt = lessonRt(step.step_index);

  const card = el("section", "panel lesson-step-panel");
  card.appendChild(el("h2", null, "先聽，不看字"));
  card.appendChild(
    el(
      "p",
      "muted",
      "播放整段對話，聽不懂沒關係 — 先猜猜看發生了什麼事，之後會逐句拆解。",
    ),
  );

  const seq = lessonState.sequence;
  const playRow = el("div", "lesson-blind-controls");

  const onProgress = (index) => {
    rt.playingIndex = index;
    const el2 = document.querySelector("#lessonSeqIndicator");
    if (el2) el2.textContent = `第 ${index + 1} / ${data.audio_urls.length} 句`;
  };

  if (seq.playing) {
    // 播放中：暫停（保留位置）＋ 停止（回到第一句）
    playRow.appendChild(
      lessonPlayIconButton(
        "暫停",
        () => {
          pauseLessonSequence();
          render();
        },
        { big: true, icon: ICON_PAUSE },
      ),
    );
    playRow.appendChild(
      lessonPlayIconButton(
        "",
        () => {
          stopLessonSequence();
          rt.playingIndex = 0;
          render();
        },
        { icon: ICON_STOP },
      ),
    );
  } else if (seq.paused) {
    // 暫停中：繼續會重念暫停的那一句，再往下播
    playRow.appendChild(
      lessonPlayIconButton(
        "繼續播放",
        () => {
          seq.onUpdate = onProgress;
          seq.onDone = () => render();
          resumeLessonSequence();
          render();
        },
        { big: true, icon: ICON_PLAY },
      ),
    );
    playRow.appendChild(
      lessonPlayIconButton(
        "",
        () => {
          stopLessonSequence();
          rt.playingIndex = 0;
          render();
        },
        { icon: ICON_STOP },
      ),
    );
  } else {
    playRow.appendChild(
      lessonPlayIconButton(
        "播放整段對話",
        () => {
          rt.playedOnce = true;
          playLessonSequence(data.audio_urls, onProgress, () => render());
          render();
        },
        { big: true, icon: ICON_PLAY },
      ),
    );
  }

  const indicator = el("span", "lesson-seq-indicator");
  indicator.id = "lessonSeqIndicator";
  if (seq.playing || seq.paused) {
    const at = (rt.playingIndex ?? 0) + 1;
    indicator.textContent = seq.paused
      ? `已暫停於第 ${at} / ${data.audio_urls.length} 句`
      : `第 ${at} / ${data.audio_urls.length} 句`;
  }
  playRow.appendChild(indicator);
  card.appendChild(playRow);
  container.appendChild(card);

  let quizDone = true;
  if (data.quiz.length) {
    const quizCard = el("section", "panel lesson-step-panel");
    quizCard.appendChild(el("h2", null, "聽完猜一猜"));
    quizDone = renderLessonQuiz(quizCard, step, data.quiz);
    container.appendChild(quizCard);
  }

  container.appendChild(lessonContinueButton(Boolean(rt.playedOnce) && quizDone));
  if (!rt.playedOnce) {
    container.appendChild(
      el("p", "lesson-step-lock-hint", "先播放一次整段對話，才能前往下一步。"),
    );
  }
}

function renderSentenceStudyStep(container, step) {
  const rt = lessonRt(step.step_index);
  const course = lessonState.lesson.course;
  const sentences = course.sentences;
  if (!rt.seen) {
    rt.seen = new Set();
    rt.index = 0;
    rt.showTranslation = false;
  }
  rt.seen.add(rt.index);
  const current = sentences[rt.index];

  const card = el("section", "panel lesson-step-panel");
  const header = el("div", "lesson-study-header");
  header.appendChild(el("h2", null, "逐句理解"));
  header.appendChild(
    el("span", "lesson-quiz-progress", `${rt.seen.size} / ${sentences.length} 句`),
  );
  card.appendChild(header);

  const tabs = el("div", "sentence-nav-tabs");
  sentences.forEach((sentence, index) => {
    const tab = el(
      "button",
      `sentence-tab ${rt.index === index ? "active" : ""}${rt.seen.has(index) ? " seen" : ""}`,
      `${index + 1}`,
    );
    tab.type = "button";
    tab.addEventListener("click", () => {
      rt.index = index;
      rt.showTranslation = false;
      render();
    });
    tabs.appendChild(tab);
  });
  card.appendChild(tabs);

  const stage = el("div", "lesson-stage-content lesson-study-stage");
  stage.appendChild(el("div", "target", current.target_text));
  if (current.romaji) {
    stage.appendChild(el("p", "lesson-romaji", current.romaji));
  }
  if (current.reading && current.reading !== current.target_text) {
    stage.appendChild(el("p", "lesson-reading", current.reading));
  }

  const translationRow = el("div", "translation-row");
  const toggleBtn = el(
    "button",
    `translation-toggle ${rt.showTranslation ? "is-visible" : ""}`,
    rt.showTranslation ? "隱藏翻譯" : "顯示翻譯",
  );
  toggleBtn.type = "button";
  toggleBtn.addEventListener("click", () => {
    rt.showTranslation = !rt.showTranslation;
    render();
  });
  translationRow.appendChild(toggleBtn);
  if (rt.showTranslation) {
    translationRow.appendChild(el("p", "lesson-translation", current.translation));
  }
  stage.appendChild(translationRow);

  const actions = el("div", "lesson-actions");
  actions.appendChild(
    createFavoriteButton({
      itemType: "sentence",
      itemId: current.id,
      isSaved: isSentenceSaved(current.id),
    }),
  );
  actions.appendChild(
    lessonPlayIconButton("播放語音", () => lessonPlayUrl(current.audio_url)),
  );
  if (rt.index > 0) {
    const prev = el("button", "lesson-btn lesson-btn-secondary", "上一句");
    prev.type = "button";
    prev.addEventListener("click", () => {
      rt.index -= 1;
      rt.showTranslation = false;
      render();
    });
    actions.appendChild(prev);
  }
  if (rt.index < sentences.length - 1) {
    const next = el("button", "lesson-btn lesson-btn-secondary", "下一句");
    next.type = "button";
    next.addEventListener("click", () => {
      rt.index += 1;
      rt.showTranslation = false;
      render();
    });
    actions.appendChild(next);
  }
  stage.appendChild(actions);
  card.appendChild(stage);
  container.appendChild(card);

  if (course.vocabulary.length) {
    const vocabCard = el("section", "panel lesson-step-panel");
    vocabCard.appendChild(el("h2", null, "本課單字"));
    vocabCard.appendChild(
      el("p", "muted", "只需要眼熟這幾個詞 — 接下來的步驟會反覆用到它們。"),
    );
    const grid = el("div", "lesson-vocab-grid");
    course.vocabulary.forEach((item) => {
      const vocab = el("article", "vocab-card");
      const top = el("div", "vocab-card-top");
      const termBlock = el("div", "vocab-term-block");
      termBlock.appendChild(el("strong", null, item.term));
      if (item.romaji) {
        termBlock.appendChild(el("span", "vocab-romaji", item.romaji));
      }
      if (item.reading && item.reading !== item.term) {
        termBlock.appendChild(el("span", "vocab-reading", item.reading));
      }
      top.appendChild(termBlock);
      if (item.audio_url) {
        const play = el("button", "vocab-play-btn", "播放");
        play.type = "button";
        play.addEventListener("click", () => lessonPlayUrl(item.audio_url));
        top.appendChild(play);
      }
      top.appendChild(
        createFavoriteButton({
          itemType: "vocabulary",
          itemId: item.id,
          isSaved: isVocabularySaved(item.id),
          compact: true,
        }),
      );
      vocab.appendChild(top);
      vocab.appendChild(el("p", "vocab-meaning", item.meaning));
      if (item.example_sentence) {
        vocab.appendChild(el("p", "vocab-example", item.example_sentence));
      }
      grid.appendChild(vocab);
    });
    vocabCard.appendChild(grid);
    container.appendChild(vocabCard);
  }

  const allSeen = rt.seen.size >= sentences.length;
  container.appendChild(lessonContinueButton(allSeen));
  if (!allSeen) {
    container.appendChild(
      el("p", "lesson-step-lock-hint", "看完全部句子後即可前往下一步。"),
    );
  }
}

function renderListenCheckStep(container, step) {
  const card = el("section", "panel lesson-step-panel");
  card.appendChild(el("h2", null, "再聽一次，驗證理解"));
  card.appendChild(
    el("p", "muted", "這次不看字 — 聽音檔選出正確意思，感受「聽得懂了」的瞬間。"),
  );
  const done = renderLessonQuiz(card, step, step.data.quiz, { revealSentence: true });
  container.appendChild(card);
  container.appendChild(lessonContinueButton(done));
}

function renderShadowingStep(container, step) {
  const rt = lessonRt(step.step_index);
  const sentenceIds = step.data.sentence_ids;
  if (!rt.played) {
    rt.played = new Set();
    rt.index = 0;
    rt.recordings = {};
    rt.recording = false;
    rt.micDenied = false;
  }
  const sentence = lessonSentenceById(sentenceIds[rt.index]);

  const card = el("section", "panel lesson-step-panel");
  const header = el("div", "lesson-study-header");
  header.appendChild(el("h2", null, "跟讀 — 模仿發音與節奏"));
  header.appendChild(
    el(
      "span",
      "lesson-quiz-progress",
      `第 ${rt.index + 1} / ${sentenceIds.length} 句（已聽 ${rt.played.size} 句）`,
    ),
  );
  card.appendChild(header);
  card.appendChild(
    el(
      "p",
      "muted",
      "播原音 → 錄下自己的聲音 → 兩相比對。沒有評分、不用完美，跟上節奏就好。",
    ),
  );

  const stage = el("div", "lesson-stage-content lesson-shadow-stage");
  stage.appendChild(el("div", "target", sentence.target_text));
  if (sentence.romaji) {
    stage.appendChild(el("p", "lesson-romaji", sentence.romaji));
  }
  if (sentence.reading && sentence.reading !== sentence.target_text) {
    stage.appendChild(el("p", "lesson-reading", sentence.reading));
  }
  stage.appendChild(el("p", "lesson-translation", sentence.translation));

  const controls = el("div", "lesson-shadow-controls");
  controls.appendChild(
    lessonPlayIconButton("播放原音", () => {
      rt.played.add(sentence.id);
      lessonPlayUrl(sentence.audio_url);
      render();
    }),
  );

  const canRecord =
    !rt.micDenied && navigator.mediaDevices && window.MediaRecorder;
  if (canRecord) {
    const recordBtn = el(
      "button",
      `lesson-record-btn${rt.recording ? " is-recording" : ""}`,
      rt.recording ? "停止錄音" : "開始錄音",
    );
    recordBtn.type = "button";
    recordBtn.addEventListener("click", async () => {
      if (rt.recording) {
        if (rt.recorder && rt.recorder.state !== "inactive") rt.recorder.stop();
        return;
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const recorder = new MediaRecorder(stream);
        const chunks = [];
        recorder.ondataavailable = (event) => {
          if (event.data.size) chunks.push(event.data);
        };
        recorder.onstop = () => {
          stream.getTracks().forEach((track) => track.stop());
          const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
          const previous = rt.recordings[sentence.id];
          if (previous) URL.revokeObjectURL(previous);
          rt.recordings[sentence.id] = URL.createObjectURL(blob);
          rt.recording = false;
          rt.recorder = null;
          render();
        };
        rt.recorder = recorder;
        rt.recording = true;
        recorder.start();
        render();
      } catch {
        rt.micDenied = true;
        render();
      }
    });
    controls.appendChild(recordBtn);

    if (rt.recordings[sentence.id]) {
      controls.appendChild(
        lessonPlayIconButton("播放我的錄音", () => {
          stopLessonSequence();
          lessonAudio.src = rt.recordings[sentence.id];
          lessonAudio.play().catch(() => {});
        }),
      );
    }
  } else if (rt.micDenied) {
    controls.appendChild(
      el(
        "p",
        "lesson-mic-hint",
        "無法使用麥克風 — 沒關係，跟著原音大聲唸出來，效果一樣好。",
      ),
    );
  }
  stage.appendChild(controls);

  const nav = el("div", "lesson-actions");
  if (rt.index > 0) {
    const prev = el("button", "lesson-btn lesson-btn-secondary", "上一句");
    prev.type = "button";
    prev.addEventListener("click", () => {
      rt.index -= 1;
      render();
    });
    nav.appendChild(prev);
  }
  if (rt.index < sentenceIds.length - 1) {
    const next = el("button", "lesson-btn lesson-btn-secondary", "下一句");
    next.type = "button";
    next.addEventListener("click", () => {
      rt.index += 1;
      render();
    });
    nav.appendChild(next);
  }
  stage.appendChild(nav);
  card.appendChild(stage);
  container.appendChild(card);

  const allPlayed = rt.played.size >= sentenceIds.length;
  container.appendChild(lessonContinueButton(allPlayed));
  if (!allPlayed) {
    container.appendChild(
      el("p", "lesson-step-lock-hint", "每一句至少播放並跟讀一次，才能前往下一步。"),
    );
  }
}

function lessonJoinTokens(tokens) {
  // 英文詞塊以空白相接、日文詞塊直接相連；以 token 是否含 ASCII 字母判斷
  const hasAscii = tokens.some((token) => /[A-Za-z]/.test(token));
  return tokens.join(hasAscii ? " " : "");
}

function renderReorderExercise(card, step, exercise, exerciseRt) {
  if (!exerciseRt.picked) exerciseRt.picked = [];

  card.appendChild(el("p", "lesson-quiz-prompt", exercise.prompt));
  card.appendChild(el("p", "lesson-exercise-translation", exercise.translation));

  const answerRow = el("div", "lesson-reorder-answer");
  if (!exerciseRt.picked.length) {
    answerRow.appendChild(el("span", "lesson-reorder-placeholder", "點下方詞塊組句"));
  }
  exerciseRt.picked.forEach((tokenIndex, position) => {
    const chip = el("button", "lesson-token is-picked", exercise.tokens[tokenIndex]);
    chip.type = "button";
    chip.disabled = Boolean(exerciseRt.done);
    chip.addEventListener("click", () => {
      exerciseRt.picked.splice(position, 1);
      render();
    });
    answerRow.appendChild(chip);
  });
  card.appendChild(answerRow);

  const pool = el("div", "lesson-reorder-pool");
  exercise.tokens.forEach((token, tokenIndex) => {
    if (exerciseRt.picked.includes(tokenIndex)) return;
    const chip = el("button", "lesson-token", token);
    chip.type = "button";
    chip.disabled = Boolean(exerciseRt.done);
    chip.addEventListener("click", () => {
      exerciseRt.picked.push(tokenIndex);
      render();
    });
    pool.appendChild(chip);
  });
  card.appendChild(pool);

  if (!exerciseRt.done) {
    const checkBtn = el("button", "primary-button lesson-quiz-next", "檢查");
    checkBtn.type = "button";
    checkBtn.disabled = exerciseRt.picked.length !== exercise.tokens.length;
    checkBtn.addEventListener("click", () => {
      const built = exerciseRt.picked.map((tokenIndex) => exercise.tokens[tokenIndex]);
      const correct = lessonJoinTokens(built) === lessonJoinTokens(exercise.answer);
      exerciseRt.done = true;
      exerciseRt.correct = correct;
      recordLessonAttempt(step, exercise, correct);
      render();
    });
    card.appendChild(checkBtn);
  } else {
    card.appendChild(
      lessonFeedbackBanner(exerciseRt.correct, lessonJoinTokens(exercise.answer)),
    );
    if (exercise.audio_url) {
      card.appendChild(
        lessonPlayIconButton("聽這句", () => lessonPlayUrl(exercise.audio_url)),
      );
    }
  }
}

function renderClozeChoiceExercise(card, step, exercise, exerciseRt) {
  card.appendChild(el("p", "lesson-quiz-prompt", exercise.prompt));
  card.appendChild(el("p", "lesson-cloze-text", exercise.masked_text));
  card.appendChild(el("p", "lesson-exercise-translation", exercise.translation));

  const optionList = el("div", "lesson-quiz-options");
  exercise.options.forEach((option) => {
    let className = "lesson-quiz-option";
    if (exerciseRt.done) {
      if (option.id === exercise.answer_id) className += " is-correct";
      else if (option.id === exerciseRt.selectedId) className += " is-wrong";
      className += " is-locked";
    }
    const button = el("button", className, option.text);
    button.type = "button";
    button.disabled = Boolean(exerciseRt.done);
    button.addEventListener("click", () => {
      const correct = option.id === exercise.answer_id;
      exerciseRt.done = true;
      exerciseRt.correct = correct;
      exerciseRt.selectedId = option.id;
      recordLessonAttempt(step, exercise, correct);
      render();
    });
    optionList.appendChild(button);
  });
  card.appendChild(optionList);

  if (exerciseRt.done) {
    const correctOption = exercise.options.find(
      (option) => option.id === exercise.answer_id,
    );
    card.appendChild(
      lessonFeedbackBanner(exerciseRt.correct, correctOption ? correctOption.text : ""),
    );
  }
}

function normalizeDictation(value, isEnglish) {
  let text = String(value || "").trim();
  if (isEnglish) {
    text = text.toLowerCase().replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "");
  }
  return text;
}

function renderDictationExercise(card, step, exercise, exerciseRt) {
  if (exerciseRt.tries === undefined) exerciseRt.tries = 0;

  card.appendChild(el("p", "lesson-quiz-prompt", exercise.prompt));
  card.appendChild(
    lessonPlayIconButton("播放音檔", () => lessonPlayUrl(exercise.audio_url), {
      big: true,
    }),
  );
  card.appendChild(el("p", "lesson-cloze-text", exercise.masked_text));
  card.appendChild(el("p", "lesson-exercise-translation", exercise.translation));

  const isEnglish = exercise.answers.some((answer) => /[A-Za-z]/.test(answer));

  if (!exerciseRt.done) {
    const inputRow = el("div", "lesson-dictation-row");
    const input = el("input", "lesson-dictation-input");
    input.type = "text";
    input.placeholder = "把聽到的詞打出來";
    input.value = exerciseRt.draft || "";
    input.addEventListener("input", () => {
      exerciseRt.draft = input.value;
    });
    const check = () => {
      const normalized = normalizeDictation(input.value, isEnglish);
      const correct = exercise.answers.some(
        (answer) => normalizeDictation(answer, isEnglish) === normalized,
      );
      if (correct) {
        exerciseRt.done = true;
        exerciseRt.correct = true;
        recordLessonAttempt(step, exercise, true);
        render();
        return;
      }
      exerciseRt.tries += 1;
      if (exerciseRt.tries >= 2) {
        exerciseRt.done = true;
        exerciseRt.correct = false;
        recordLessonAttempt(step, exercise, false);
        render();
        return;
      }
      exerciseRt.wrongOnce = true;
      render();
    };
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") check();
    });
    inputRow.appendChild(input);
    const checkBtn = el("button", "primary-button", "檢查");
    checkBtn.type = "button";
    checkBtn.addEventListener("click", check);
    inputRow.appendChild(checkBtn);
    card.appendChild(inputRow);
    if (exerciseRt.wrongOnce) {
      card.appendChild(
        el("p", "lesson-dictation-hint", "還差一點 — 再聽一次音檔試試看。"),
      );
    }
    requestAnimationFrame(() => input.focus());
  } else {
    card.appendChild(lessonFeedbackBanner(exerciseRt.correct, exercise.answers[0]));
  }
}

function renderExerciseStep(container, step, headline, subline) {
  const rt = lessonRt(step.step_index);
  if (!rt.exercises) {
    rt.exercises = step.data.exercises.map(() => ({}));
    rt.current = 0;
  }
  const exercises = step.data.exercises;
  const index = rt.current;
  const done = index >= exercises.length;

  const card = el("section", "panel lesson-step-panel");
  card.appendChild(el("h2", null, headline));
  card.appendChild(el("p", "muted", subline));
  card.appendChild(
    el(
      "p",
      "lesson-quiz-progress",
      done ? `已完成 ${exercises.length} 題` : `第 ${index + 1} / ${exercises.length} 題`,
    ),
  );

  if (!done) {
    const exercise = exercises[index];
    const exerciseRt = rt.exercises[index];
    const body = el("div", "lesson-quiz-card");
    if (exercise.kind === "reorder") {
      renderReorderExercise(body, step, exercise, exerciseRt);
    } else if (exercise.kind === "cloze_choice") {
      renderClozeChoiceExercise(body, step, exercise, exerciseRt);
    } else if (exercise.kind === "dictation") {
      renderDictationExercise(body, step, exercise, exerciseRt);
    }
    if (exerciseRt.done) {
      const nextBtn = el(
        "button",
        "primary-button lesson-quiz-next",
        index + 1 < exercises.length ? "下一題" : "完成作答",
      );
      nextBtn.type = "button";
      nextBtn.addEventListener("click", () => {
        rt.current += 1;
        render();
      });
      body.appendChild(nextBtn);
    }
    card.appendChild(body);
  } else {
    const correctCount = rt.exercises.filter((exercise) => exercise.correct).length;
    card.appendChild(el("p", null, `答對 ${correctCount} / ${exercises.length} 題`));
  }

  container.appendChild(card);
  container.appendChild(lessonContinueButton(done));
}

function renderResultStep(container) {
  const { percent, total, bySkill } = lessonScore();
  const lesson = lessonState.lesson;

  const card = el("section", "panel lesson-step-panel lesson-result");
  card.appendChild(el("h2", null, "任務完成 🎉"));

  const ring = el("div", "progress-ring lesson-result-ring");
  ring.style.background = `conic-gradient(var(--green) 0 ${percent}%, #e9edf5 ${percent}% 100%)`;
  ring.appendChild(el("span", null, `${percent}%`));
  card.appendChild(ring);

  card.appendChild(
    el(
      "p",
      "lesson-result-statement",
      `你現在可以完成「${lesson.scenario_title}」的${lesson.course.title}情境對話。`,
    ),
  );

  const grade =
    percent >= 90
      ? "表現極佳！這一課的內容已經進入你的長期記憶軌道。"
      : percent >= 70
        ? "表現良好！錯過的題目明天複習一次，會記得更牢。"
        : "已經完成一輪！建議再聽一次盲聽與跟讀，第二輪會輕鬆很多。";
  card.appendChild(el("p", "muted", grade));

  if (total) {
    const skillRow = el("div", "lesson-result-skills");
    Object.entries(bySkill).forEach(([skill, stats]) => {
      const chip = el("span", "tag blue");
      chip.textContent = `${SKILL_LABELS[skill] || skill} ${stats.correct}/${stats.total}`;
      skillRow.appendChild(chip);
    });
    card.appendChild(skillRow);
  }

  const actions = el("div", "lesson-result-actions");
  const againBtn = el("button", "ghost-button", "再學一次");
  againBtn.type = "button";
  againBtn.addEventListener("click", () =>
    startLesson(lessonState.scenarioId, lessonState.courseId),
  );
  actions.appendChild(againBtn);

  const browseBtn = el("button", "ghost-button", "瀏覽本課內容");
  browseBtn.type = "button";
  browseBtn.addEventListener("click", openLessonBrowseMode);
  actions.appendChild(browseBtn);

  const backBtn = el("button", "primary-button", "返回課程列表");
  backBtn.type = "button";
  backBtn.addEventListener("click", exitLessonToScenario);
  actions.appendChild(backBtn);
  card.appendChild(actions);

  container.appendChild(card);
}

// ---------------------------------------------------------------------------
// 主渲染
// ---------------------------------------------------------------------------

function renderLessonStepBar(container) {
  const bar = el("div", "lesson-step-bar");
  lessonSteps().forEach((step, index) => {
    const reachable = index <= lessonState.maxStepReached;
    let className = "lesson-step-dot";
    if (index === lessonState.stepIndex) className += " is-active";
    else if (reachable) className += " is-done";
    const button = el("button", className);
    button.type = "button";
    button.disabled = !reachable;
    button.appendChild(el("span", "lesson-step-num", `${index + 1}`));
    button.appendChild(el("span", "lesson-step-label", step.title));
    button.addEventListener("click", () => gotoLessonStep(index));
    bar.appendChild(button);
  });
  container.appendChild(bar);
}

function renderLessonView() {
  clear(viewRoot);
  const page = el("div", "lesson-flow-page");
  viewRoot.appendChild(page);

  if (lessonState.loading) {
    const panel = el("section", "panel");
    panel.appendChild(el("p", "muted", "載入學習流程中…"));
    page.appendChild(panel);
    return;
  }

  if (lessonState.error || !lessonState.lesson) {
    const panel = el("section", "panel");
    panel.appendChild(el("h2", null, "無法載入學習流程"));
    panel.appendChild(el("p", "muted", lessonState.error || "課程不存在"));
    const backBtn = el("button", "primary-button", "返回學習探索");
    backBtn.type = "button";
    backBtn.addEventListener("click", () => navigateTo("learn"));
    panel.appendChild(backBtn);
    page.appendChild(panel);
    return;
  }

  const lesson = lessonState.lesson;
  page.appendChild(
    createPageHeader(
      lesson.course.title,
      `${lesson.scenario_title} · 第 ${lesson.course.order_index} 課`,
      "離開學習流程",
      exitLessonToScenario,
    ),
  );

  renderLessonStepBar(page);

  const step = currentLessonStep();
  const body = el("div", "lesson-flow-body");
  if (step.type === "mission") renderMissionStep(body, step);
  else if (step.type === "vocab_preview") renderVocabPreviewStep(body, step);
  else if (step.type === "blind_listen") renderBlindListenStep(body, step);
  else if (step.type === "sentence_study") renderSentenceStudyStep(body, step);
  else if (step.type === "listen_check") renderListenCheckStep(body, step);
  else if (step.type === "shadowing") renderShadowingStep(body, step);
  else if (step.type === "apply") {
    renderExerciseStep(
      body,
      step,
      "靈活應用",
      "把學過的句子拆開重組、填回關鍵詞 — 讓句子變成你能組裝的工具。",
    );
  } else if (step.type === "write") {
    renderExerciseStep(
      body,
      step,
      "寫下來",
      "最後一關：聽音檔，把關鍵詞打出來。寫得出來，就是真的會了。",
    );
  } else if (step.type === "result") renderResultStep(body);
  page.appendChild(body);
}

window.learnflowLesson = {
  start: startLesson,
  renderView: renderLessonView,
};
