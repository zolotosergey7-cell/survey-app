// ─────────────────────────────────────────────
// server.js — сервер с анализом Claude
// ─────────────────────────────────────────────

require("dotenv").config();

const express    = require("express");
const http       = require("http");
const { Server } = require("socket.io");
const QRCode     = require("qrcode");
const path       = require("path");
const XLSX       = require("xlsx");
const OpenAI = require("openai");

const { BLOCKS, ALL_QUESTIONS, SCALE5_LABELS } = require("./data");

const app    = express();
const server = http.createServer(app);
const io     = new Server(server);
const client = new OpenAI({
  apiKey:  "pza_zMH-RrOw4OQBfpgFGjw4eyUznccGYSDP",
  baseURL: "https://polza.ai/api/v1"
});

const PORT = process.env.PORT || 3000;

// ── Хранилище сессий (in-memory) ──────────────────────────
const sessions = new Map();

// ── Вспомогательные функции ───────────────────────────────

function generateSessionId() {
  return "SURV-" + Math.floor(1000 + Math.random() * 9000);
}

function generateRespondentId() {
  return "r_" + Date.now() + "_" + Math.floor(Math.random() * 1000);
}

function calcBlockAverages(responses) {
  const result = {};
  BLOCKS.forEach(block => {
    const scaleQs = block.questions.filter(q => q.type === "scale5" || q.type === "scale10");
    if (scaleQs.length === 0) return;
    let total = 0, count = 0;
    responses.forEach(resp => {
      scaleQs.forEach(q => {
        const ans = resp.answers[q.id];
        if (ans !== undefined && ans !== null) { total += Number(ans); count++; }
      });
    });
    result[block.id] = count > 0 ? Math.round((total / count) * 10) / 10 : 0;
  });
  return result;
}

function calcChoiceDistribution(responses, questionId) {
  const dist = {};
  responses.forEach(resp => {
    const ans = resp.answers[questionId];
    if (ans !== undefined && ans !== null) dist[ans] = (dist[ans] || 0) + 1;
  });
  return dist;
}

function scheduleCleanup(sessionId) {
  setTimeout(() => { sessions.delete(sessionId); }, 24 * 60 * 60 * 1000);
}

// ── Формирует промпт для Claude ───────────────────────────
function buildPrompt(session, averages, choiceDist, textAnswers) {
  const blockLines = BLOCKS
    .filter(b => averages[b.id] !== undefined)
    .map(b => `  Блок ${b.id} — ${b.title}: ${averages[b.id]} из 5`)
    .join("\n");

  const choiceLines = [];
  const q11dist = choiceDist[11];
  const q16dist = choiceDist[16];
  if (q11dist && Object.keys(q11dist).length > 0) {
    const top = Object.entries(q11dist).sort((a,b) => b[1]-a[1])[0];
    choiceLines.push(`  Отдел с наибольшими трудностями в коммуникации: ${top[0]} (${top[1]} голосов)`);
  }
  if (q16dist && Object.keys(q16dist).length > 0) {
    const top = Object.entries(q16dist).sort((a,b) => b[1]-a[1])[0];
    choiceLines.push(`  Наиболее эффективный канал коммуникации: ${top[0]} (${top[1]} голосов)`);
  }

  const textLines = textAnswers.length > 0
    ? textAnswers.map((t, i) => `  ${i+1}. "${t}"`).join("\n")
    : "  Открытых ответов нет";

  return `Ты — эксперт по корпоративным коммуникациям и организационному развитию.

Проанализируй результаты анонимного опроса сотрудников компании "${session.companyName}".
Количество ответов: ${session.responses.length}

СРЕДНИЕ БАЛЛЫ ПО БЛОКАМ (шкала 1–5, где 1 — плохо, 5 — отлично):
${blockLines}

ДОПОЛНИТЕЛЬНЫЕ ДАННЫЕ:
${choiceLines.join("\n") || "  Нет данных"}

ОТКРЫТЫЕ ОТВЕТЫ СОТРУДНИКОВ:
${textLines}

Напиши структурированный аналитический отчёт строго в следующем формате:

## 🎯 Общий вывод
(2-3 предложения об общем уровне коммуникации в компании)

## ✅ Сильные стороны
(2-3 конкретных сильных стороны на основе данных)

## ⚠️ Проблемные зоны
(2-3 конкретные проблемы требующие внимания)

## 📋 Рекомендации по блокам
(краткая рекомендация по каждому блоку где балл ниже 3.5)

## 🚀 Приоритеты для руководителя
(3 конкретных действия которые дадут максимальный эффект в ближайшие 30 дней)

Пиши конкретно, без воды. Опирайся на цифры и открытые ответы сотрудников.`;
}

// ── Статика и JSON ────────────────────────────────────────
app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

// ── API: данные опроса ────────────────────────────────────
app.get("/api/survey-data", (req, res) => {
  res.json({ blocks: BLOCKS, scale5Labels: SCALE5_LABELS });
});

// ── API: создать сессию ───────────────────────────────────
app.post("/api/session/create", async (req, res) => {
  const { companyName, pin } = req.body;
  let sessionId = generateSessionId();
  while (sessions.has(sessionId)) sessionId = generateSessionId();

  const BASE_URL = process.env.RAILWAY_STATIC_URL
    ? `https://${process.env.RAILWAY_STATIC_URL}`
    : `http://localhost:${PORT}`;

  const participantUrl = `${BASE_URL}/participant/?s=${sessionId}`;
  const qrDataUrl = await QRCode.toDataURL(participantUrl, { width: 300 });

  const session = {
    id: sessionId, companyName: companyName || "Компания",
    pin: pin || null, createdAt: Date.now(), responses: []
  };
  sessions.set(sessionId, session);
  scheduleCleanup(sessionId);

  res.json({ sessionId, participantUrl, qrDataUrl,
    trainerUrl: `${BASE_URL}/trainer/?s=${sessionId}` });
});

// ── API: получить сессию ──────────────────────────────────
app.get("/api/session/:sessionId", (req, res) => {
  const session = sessions.get(req.params.sessionId);
  if (!session) return res.status(404).json({ error: "Сессия не найдена" });

  const averages   = calcBlockAverages(session.responses);
  const choiceQs   = ALL_QUESTIONS.filter(q => q.type === "choice");
  const choiceDist = {};
  choiceQs.forEach(q => { choiceDist[q.id] = calcChoiceDistribution(session.responses, q.id); });
  const textAnswers = session.responses.map(r => r.answers[20]).filter(a => a && a.trim() !== "");

  res.json({ id: session.id, companyName: session.companyName,
    createdAt: session.createdAt, totalCount: session.responses.length,
    averages, choiceDist, textAnswers });
});

// ── API: отправить ответы ─────────────────────────────────
app.post("/api/session/:sessionId/submit", (req, res) => {
  const session = sessions.get(req.params.sessionId);
  if (!session) return res.status(404).json({ error: "Сессия не найдена" });

  session.responses.push({
    id: generateRespondentId(), submittedAt: Date.now(), answers: req.body.answers
  });

  const averages   = calcBlockAverages(session.responses);
  const choiceQs   = ALL_QUESTIONS.filter(q => q.type === "choice");
  const choiceDist = {};
  choiceQs.forEach(q => { choiceDist[q.id] = calcChoiceDistribution(session.responses, q.id); });
  const textAnswers = session.responses.map(r => r.answers[20]).filter(a => a && a.trim() !== "");

  io.to(req.params.sessionId).emit("newResponse", {
    totalCount: session.responses.length, averages, choiceDist, textAnswers
  });

  res.json({ success: true });
});

// ── API: анализ Claude ────────────────────────────────────
app.post("/api/session/:sessionId/analyze", async (req, res) => {
  const session = sessions.get(req.params.sessionId);
  if (!session) return res.status(404).json({ error: "Сессия не найдена" });
  if (session.responses.length < 3) {
    return res.status(400).json({ error: "Нужно минимум 3 ответа для анализа" });
  }

  const averages   = calcBlockAverages(session.responses);
  const choiceQs   = ALL_QUESTIONS.filter(q => q.type === "choice");
  const choiceDist = {};
  choiceQs.forEach(q => { choiceDist[q.id] = calcChoiceDistribution(session.responses, q.id); });
  const textAnswers = session.responses.map(r => r.answers[20]).filter(a => a && a.trim() !== "");

  try {
    const message = await client.chat.completions.create({
  model:      "anthropic/claude-sonnet-4.6",
  max_tokens: 1500,
  messages: [{
    role:    "user",
    content: buildPrompt(session, averages, choiceDist, textAnswers)
  }]
});

   const analysis = message.choices?.[0]?.message?.content
  || message.content?.[0]?.text
  || JSON.stringify(message);

    // Уведомляем дашборд через WebSocket
    io.to(req.params.sessionId).emit("analysisReady", { analysis });

    res.json({ analysis });

  } catch (e) {
    console.error("Claude API error:", e.message);
    res.status(500).json({ error: "Ошибка при обращении к Claude API: " + e.message });
  }
});

// ── API: экспорт Excel ────────────────────────────────────
app.get("/api/session/:sessionId/export", (req, res) => {
  const session = sessions.get(req.params.sessionId);
  if (!session) return res.status(404).json({ error: "Сессия не найдена" });

  const headers = ["№", "Время"];
  ALL_QUESTIONS.forEach(q => headers.push(`Q${q.id}`));
  const rows = session.responses.map((r, i) => {
    const row = [i + 1, new Date(r.submittedAt).toLocaleString("ru-RU")];
    ALL_QUESTIONS.forEach(q => row.push(r.answers[q.id] !== undefined ? r.answers[q.id] : ""));
    return row;
  });
  const questionRef = ALL_QUESTIONS.map(q => [`Q${q.id}`, q.text]);

  const wb  = XLSX.utils.book_new();
  const ws1 = XLSX.utils.aoa_to_sheet([headers, ...rows]);
  const ws2 = XLSX.utils.aoa_to_sheet([["Код", "Вопрос"], ...questionRef]);
  XLSX.utils.book_append_sheet(wb, ws1, "Ответы");
  XLSX.utils.book_append_sheet(wb, ws2, "Вопросы");

  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
  res.setHeader("Content-Disposition", `attachment; filename="survey-${req.params.sessionId}.xlsx"`);
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.send(buf);
});

// ── WebSocket ─────────────────────────────────────────────
io.on("connection", socket => {
  socket.on("joinSession", ({ sessionId }) => socket.join(sessionId));
});

// ── Запуск ────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log("─────────────────────────────────────────");
  console.log(`Сервер запущен: http://localhost:${PORT}`);
  console.log(`Панель:         http://localhost:${PORT}/trainer/`);
  console.log("─────────────────────────────────────────");
});