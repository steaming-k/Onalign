import { useState, useEffect, useRef, useCallback } from "react";
import { storage } from "./storage";
import Logo from "./components/Logo";
import ConfirmDialog from "./components/ConfirmDialog";

const PALETTE = [
  { name: "pink", bg: "#f7d3de", border: "#e8a9bd", text: "#7a2e46" },
  { name: "olive", bg: "#dde3ba", border: "#b9c488", text: "#4a5225" },
  { name: "blue", bg: "#bcd9ee", border: "#8ab6d8", text: "#1f4c6b" },
  { name: "purple", bg: "#d6c9ee", border: "#b09fd9", text: "#4a3670" },
  { name: "tan", bg: "#eecd9c", border: "#dba965", text: "#6b4415" },
  { name: "teal", bg: "#a9e6d3", border: "#72c9ac", text: "#1e5c47" },
];

// 프로젝트 목록은 하나의 인덱스 키로 관리하고, 각 프로젝트의 실제 보드 내용은
// 프로젝트 id를 포함한 별도 키에 저장한다 -> 프로젝트가 늘어나도 목록 조회는 가볍게 유지됨
const PROJECTS_INDEX_KEY = "facilitation-projects-index";
const boardKeyOf = (projectId) => `facilitation-board:${projectId}`;
// 2번: "이 브라우저 = 나"라는 개인 로컬 상태이므로 공유 저장소(storage 어댑터)가 아니라
// localStorage에 직접 저장한다. 프로젝트 id 단위로 구분해 다른 프로젝트에선 다시 이름을 묻는다.
const myNameKeyOf = (projectId) => `facilitation-myname:${projectId}`;
function getSavedName(projectId) {
  try {
    return localStorage.getItem(myNameKeyOf(projectId));
  } catch (e) {
    return null;
  }
}
function setSavedName(projectId, name) {
  try {
    localStorage.setItem(myNameKeyOf(projectId), name);
  } catch (e) {
    /* noop */
  }
}
function clearSavedName(projectId) {
  try {
    localStorage.removeItem(myNameKeyOf(projectId));
  } catch (e) {
    /* noop */
  }
}

const DEFAULT_INSTRUCTIONS =
  "퍼실리테이션: 집단이 공통의 목표를 달성하기 위해, 구성원들의 적극적인 참여와 소통을 촉진하여 효과적인 의사결정과 문제 해결을 하도록 돕는 과정입니다.\n소외되는 인원 없이 모두의 의견을 다양하게 들어볼 수 있다는 점이 장점입니다. 아래 보드에 자유롭게 작성해주세요.";

const emptyBoard = () => ({
  phase: "opinion",
  users: {},
  // 의견을 주제별로 나눠 받고 싶을 때를 위한 다중 보드 구조. 기본은 1개에서 시작하고 필요하면 늘린다
  topics: [{ id: uid(), title: "의견1" }],
  instructions: DEFAULT_INSTRUCTIONS,
  // 6번: "문제"는 별도 배열이 아니라 note.isProblem 플래그로 표현한다(데이터 복제 없음).
  notes: [],
  votesPerUser: 3,
  // 7번: 투표는 note.id 기준으로 집계한다. votes[noteId] = [이름, ...]
  votes: {},
});

// 이전 버전에서 저장된 보드를 열어도 깨지지 않도록 보정한다.
// 특히 구버전의 별도 problems 배열을 note.isProblem + votes 재키잉으로 마이그레이션한다.
function normalizeBoard(raw) {
  const b = { ...emptyBoard(), ...raw };
  if (!b.topics || b.topics.length === 0) {
    b.topics = [{ id: uid(), title: "의견1" }];
  }
  if (!b.instructions) b.instructions = DEFAULT_INSTRUCTIONS;
  const firstTopicId = b.topics[0].id;
  b.notes = (b.notes || []).map((n) => ({ ...n, topicId: n.topicId || firstTopicId }));
  b.votes = b.votes || {};

  // ---- 구버전 problems 배열 마이그레이션 ----
  if (Array.isArray(b.problems)) {
    for (const p of b.problems) {
      if (p.sourceId) {
        // 의견에서 승격된 문제 -> 원본 노트에 isProblem 표시하고 표를 노트 id로 옮김
        const note = b.notes.find((n) => n.id === p.sourceId);
        if (note) {
          note.isProblem = true;
          if (b.votes[p.id] && !b.votes[note.id]) b.votes[note.id] = b.votes[p.id];
        }
      } else {
        // 직접 추가된 문제 -> 첫 보드에 문제 노트로 새로 만든다
        const nid = uid();
        b.notes.push({ id: nid, text: p.text || "", authors: p.authors || [], topicId: firstTopicId, isProblem: true });
        if (b.votes[p.id]) b.votes[nid] = b.votes[p.id];
      }
      // 노트 id로 옮겼으니 옛 problemId로 남은 표는 정리
      if (p.id && b.votes[p.id] && !b.notes.some((n) => n.id === p.id)) delete b.votes[p.id];
    }
    delete b.problems;
  }
  return b;
}

function uid() {
  return Math.random().toString(36).slice(2, 10);
}

// 안내 문구처럼 내용이 가변적인 textarea가 잘리거나 스크롤바가 생기지 않도록
// 내용 높이(scrollHeight)에 맞춰 실제 높이를 매번 다시 맞춰준다
function autoResizeTextarea(el) {
  if (!el) return;
  el.style.height = "auto";
  el.style.height = el.scrollHeight + "px";
}

// 가장 적게 쓰인 색상군 중에서 무작위 배정 -> 인원이 많아져도 특정 색으로 쏠리지 않게 함
function pickColor(users) {
  const used = Object.values(users).map((u) => u.color.name);
  const counts = PALETTE.map((c) => used.filter((n) => n === c.name).length);
  const min = Math.min(...counts);
  const candidates = PALETTE.filter((_, i) => counts[i] === min);
  return candidates[Math.floor(Math.random() * candidates.length)];
}

// 캔버스에 "진행 과정 -> 최종 결과" 요약 이미지를 그려 PNG로 내보낸다.
// 두 번 측정하는 대신 행 높이를 고정하고 긴 텍스트는 말줄임표로 자른다 -> 레이아웃 계산이 단순해짐
function renderSummaryCanvas(project, board) {
  const width = 1000;
  const margin = 40;
  const contentWidth = width - margin * 2;
  const noteCols = 3;
  const noteColWidth = (contentWidth - 16 * (noteCols - 1)) / noteCols;
  const NOTE_ROW_H = 84;
  const PROBLEM_ROW_H = 56;
  const VOTE_ROW_H = 46;

  const problemNotes = board.notes.filter((n) => n.isProblem);
  const noteRows = Math.ceil(board.notes.length / noteCols) || 0;
  const sortedProblems = [...problemNotes].sort(
    (a, b) => (board.votes[b.id]?.length || 0) - (board.votes[a.id]?.length || 0)
  );

  const height =
    margin * 2 +
    100 + // 헤더(프로젝트명, 날짜)
    46 + // 섹션1 제목
    noteRows * (NOTE_ROW_H + 12) +
    40 + // 섹션 간 여백
    46 + // 섹션2 제목
    problemNotes.length * PROBLEM_ROW_H +
    40 +
    46 + // 섹션3 제목
    sortedProblems.length * VOTE_ROW_H +
    40;

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = Math.max(height, 500);
  const ctx = canvas.getContext("2d");

  const truncate = (text, maxWidth, font) => {
    ctx.font = font;
    if (ctx.measureText(text).width <= maxWidth) return text;
    let t = text;
    while (t.length > 0 && ctx.measureText(t + "…").width > maxWidth) {
      t = t.slice(0, -1);
    }
    return t + "…";
  };

  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  let y = margin;

  // 헤더
  ctx.fillStyle = "#1a1a1a";
  ctx.font = "600 26px sans-serif";
  ctx.fillText(project.title, margin, y + 30);
  ctx.fillStyle = "#888888";
  ctx.font = "13px sans-serif";
  const dateStr = new Date().toLocaleDateString("ko-KR");
  ctx.fillText(`퍼실리테이션 보드 요약 · ${dateStr} · 참여자 ${Object.keys(board.users).length}명`, margin, y + 54);
  y += 90;

  // 섹션 1: 의견 모음 (진행 과정의 출발점)
  ctx.fillStyle = "#1a1a1a";
  ctx.font = "600 17px sans-serif";
  ctx.fillText("1. 의견 모음", margin, y);
  y += 30;
  board.notes.forEach((note, i) => {
    const col = i % noteCols;
    const row = Math.floor(i / noteCols);
    const x = margin + col * (noteColWidth + 16);
    const cardY = y + row * (NOTE_ROW_H + 12);
    const color = board.users[note.authors[0]]?.color || PALETTE[0];
    ctx.fillStyle = color.bg;
    ctx.strokeStyle = color.border;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(x, cardY, noteColWidth, NOTE_ROW_H, 8);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = color.text;
    ctx.font = "13px sans-serif";
    ctx.fillText(truncate(note.text, noteColWidth - 24, "13px sans-serif"), x + 12, cardY + 26);
    ctx.font = "11px sans-serif";
    ctx.globalAlpha = 0.75;
    ctx.fillText(truncate(note.authors.join(", "), noteColWidth - 24, "11px sans-serif"), x + 12, cardY + NOTE_ROW_H - 12);
    ctx.globalAlpha = 1;
  });
  if (board.notes.length === 0) {
    ctx.fillStyle = "#aaaaaa";
    ctx.font = "13px sans-serif";
    ctx.fillText("작성된 의견이 없습니다.", margin, y + 16);
  }
  y += noteRows * (NOTE_ROW_H + 12) + 40;

  // 섹션 2: 문제로 표시된 의견 (중간 결과)
  ctx.fillStyle = "#1a1a1a";
  ctx.font = "600 17px sans-serif";
  ctx.fillText("2. 문제로 표시된 의견", margin, y);
  y += 30;
  problemNotes.forEach((p) => {
    ctx.fillStyle = "#f7f7f5";
    ctx.beginPath();
    ctx.roundRect(margin, y, contentWidth, PROBLEM_ROW_H - 12, 8);
    ctx.fill();
    ctx.fillStyle = "#333333";
    ctx.font = "14px sans-serif";
    ctx.fillText(truncate(p.text, contentWidth - 30, "14px sans-serif"), margin + 16, y + 30);
    y += PROBLEM_ROW_H;
  });
  if (problemNotes.length === 0) {
    ctx.fillStyle = "#aaaaaa";
    ctx.font = "13px sans-serif";
    ctx.fillText("문제로 표시된 의견이 없습니다.", margin, y + 16);
    y += 20;
  }
  y += 30;

  // 섹션 3: 우선순위별 결과 (득표순, 진행 과정의 도착점)
  ctx.fillStyle = "#1a1a1a";
  ctx.font = "600 17px sans-serif";
  ctx.fillText("3. 우선순위별 결과", margin, y);
  y += 30;
  const maxVotes = Math.max(1, ...sortedProblems.map((p) => board.votes[p.id]?.length || 0));
  const barAreaWidth = contentWidth - 260;
  sortedProblems.forEach((p, i) => {
    const votes = board.votes[p.id]?.length || 0;
    ctx.fillStyle = "#333333";
    ctx.font = "13px sans-serif";
    ctx.fillText(`${i + 1}.`, margin, y + 18);
    ctx.fillText(truncate(p.text, 190, "13px sans-serif"), margin + 24, y + 18);
    const barW = (votes / maxVotes) * barAreaWidth;
    ctx.fillStyle = i === 0 ? "#d4537e" : "#c9c6bd";
    ctx.beginPath();
    ctx.roundRect(margin + 230, y + 4, Math.max(barW, 2), 16, 4);
    ctx.fill();
    ctx.fillStyle = "#666666";
    ctx.font = "12px sans-serif";
    ctx.fillText(`${votes}표`, margin + 240 + barAreaWidth, y + 17);
    y += VOTE_ROW_H;
  });
  if (sortedProblems.length === 0) {
    ctx.fillStyle = "#aaaaaa";
    ctx.font = "13px sans-serif";
    ctx.fillText("결과가 없습니다.", margin, y + 16);
  }

  return canvas;
}

// ===== 4번: 과정+결과 문서화 (표 중심) =====
// 앱 내 문서 뷰와 다운로드가 같은 데이터를 쓰도록, 표에 필요한 값을 한 곳에서 계산한다.
function buildDocModel(project, board) {
  const participants = Object.entries(board.users).map(([name, u]) => ({ name, color: u.color }));
  const notesByTopic = board.topics.map((t) => ({
    title: t.title,
    notes: board.notes.filter((n) => n.topicId === t.id),
  }));
  const problemNotes = board.notes.filter((n) => n.isProblem);
  const ranked = problemNotes
    .map((n) => ({ ...n, votes: board.votes[n.id]?.length || 0, voters: board.votes[n.id] || [] }))
    .sort((a, b) => b.votes - a.votes);
  return { participants, notesByTopic, problemNotes, ranked };
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

// 다운로드용 자립형 HTML 문서 문자열 생성 (브라우저에서 바로 열람·인쇄 가능)
function buildDocHtml(project, board) {
  const { participants, notesByTopic, problemNotes, ranked } = buildDocModel(project, board);
  const dateStr = new Date().toLocaleString("ko-KR");
  const topVote = ranked[0];

  const overviewRows = [
    ["프로젝트명", esc(project.title)],
    ["문서 생성일시", esc(dateStr)],
    ["참여자 수", `${participants.length}명`],
    ["작성된 의견 수", `${board.notes.length}개`],
    ["문제로 표시된 의견 수", `${problemNotes.length}개`],
    ["최다 득표", topVote ? `${esc(topVote.text)} (${topVote.votes}표)` : "—"],
  ]
    .map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`)
    .join("");

  const participantRows = participants.length
    ? participants
        .map(
          (p) =>
            `<tr><td>${esc(p.name)}</td><td><span class="chip" style="background:${p.color.bg};color:${p.color.text};border:1px solid ${p.color.border}">${p.color.name}</span></td></tr>`
        )
        .join("")
    : `<tr><td colspan="2" class="empty">참여자가 없습니다.</td></tr>`;

  const opinionRows = board.notes.length
    ? notesByTopic
        .flatMap((t) =>
          t.notes.map(
            (n) =>
              `<tr><td>${esc(t.title)}</td><td>${esc(n.text) || '<span class="empty">(빈 포스트잇)</span>'}${n.isProblem ? ' <span class="chip" style="background:#fdecec;color:#c0392b;border:1px solid #eab5b0">문제</span>' : ""}</td><td>${esc(n.authors.join(", "))}</td></tr>`
          )
        )
        .join("")
    : `<tr><td colspan="3" class="empty">작성된 의견이 없습니다.</td></tr>`;

  const problemRows = problemNotes.length
    ? problemNotes
        .map((n, i) => `<tr><td>${i + 1}</td><td>${esc(n.text)}</td><td>${esc(n.authors.join(", "))}</td></tr>`)
        .join("")
    : `<tr><td colspan="3" class="empty">문제로 표시된 의견이 없습니다.</td></tr>`;

  const voteRows = ranked.length
    ? ranked
        .map(
          (p, i) =>
            `<tr${i === 0 ? ' class="rank1"' : ""}><td>${i + 1}</td><td>${esc(p.text)}</td><td>${p.votes}표</td><td>${esc(p.voters.join(", ")) || "—"}</td></tr>`
        )
        .join("")
    : `<tr><td colspan="4" class="empty">결과가 없습니다.</td></tr>`;

  return `<!DOCTYPE html>
<html lang="ko"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>${esc(project.title)} — 퍼실리테이션 문서</title>
<style>
  body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Malgun Gothic",sans-serif;color:#242322;max-width:860px;margin:0 auto;padding:40px 24px;line-height:1.6}
  h1{font-size:26px;margin:0 0 4px}
  .sub{color:#888;font-size:13px;margin-bottom:32px}
  h2{font-size:18px;margin:36px 0 12px;padding-bottom:6px;border-bottom:2px solid #eee}
  table{width:100%;border-collapse:collapse;font-size:14px}
  th,td{border:1px solid #e8e6df;padding:9px 12px;text-align:left;vertical-align:top}
  thead th{background:#f5f2ec;font-weight:700}
  tbody th{background:#faf9f6;width:160px;white-space:nowrap}
  .chip{display:inline-block;border-radius:6px;padding:2px 10px;font-size:12px;font-weight:600}
  .empty{color:#aaa}
  .rank1 td{background:#fdf3f7}
  footer{margin-top:40px;color:#aaa;font-size:12px;text-align:center}
</style></head><body>
<h1>${esc(project.title)}</h1>
<div class="sub">Onalign 퍼실리테이션 문서 · ${esc(dateStr)}</div>

<h2>1. 개요</h2>
<table><tbody>${overviewRows}</tbody></table>

<h2>2. 참여자</h2>
<table><thead><tr><th>이름</th><th>배정 색상</th></tr></thead><tbody>${participantRows}</tbody></table>

<h2>3. 의견 모음 (과정)</h2>
<table><thead><tr><th>주제</th><th>내용</th><th>작성자</th></tr></thead><tbody>${opinionRows}</tbody></table>

<h2>4. 문제로 표시된 의견</h2>
<table><thead><tr><th>#</th><th>문제</th><th>작성자</th></tr></thead><tbody>${problemRows}</tbody></table>

<h2>5. 우선순위별 결과</h2>
<table><thead><tr><th>순위</th><th>문제</th><th>득표</th><th>투표자</th></tr></thead><tbody>${voteRows}</tbody></table>

<footer>Generated by Onalign</footer>
</body></html>`;
}

// ===== 2번 관련: 작업 흐름 안내 투어 (세션당 1회) =====
const GUIDE_SESSION_KEY = "onalign-guide-done";

// 프로젝트/이름 화면은 제외. 작업 흐름만 순서대로 연이어 안내한다.
const TOUR_STEPS = [
  { target: "add-note", screen: "opinion", text: "포스트잇을 만들고 자유롭게 적어보세요" },
  { target: "merge", screen: "opinion", text: "비슷한 의견은 합쳐보세요" },
  { target: "note-board", screen: "opinion", text: "중요한 의견은 '문제로' 표시하세요" },
  { target: "vote-status", screen: "opinion", text: "문제로 표시된 의견에 투표하세요" },
  { target: "problem-area", screen: "problem", text: "문제 문구를 여기서 다듬으세요" },
  { target: "vote-area", screen: "voting", text: "득표순 결과를 확인하세요" },
  { target: "save-image", screen: "voting", text: "결과를 문서·이미지로 남겨보세요" },
];

function guideDoneThisSession() {
  try {
    return !!sessionStorage.getItem(GUIDE_SESSION_KEY);
  } catch (e) {
    return false;
  }
}

function GuideCoach({ phase, onGotoScreen }) {
  // 세션당 1회: 이번 세션에 이미 봤으면 -1(비활성)로 시작
  const [step, setStep] = useState(() => (guideDoneThisSession() ? -1 : 0));
  const [rect, setRect] = useState(null);

  const active = step >= 0 && step < TOUR_STEPS.length ? TOUR_STEPS[step] : null;

  // 현재 단계 화면과 보드 화면이 다르면 해당 탭으로 자동 전환 -> 흐름대로 연이어 안내
  useEffect(() => {
    if (active && active.screen !== phase) onGotoScreen(active.screen);
  }, [active, phase, onGotoScreen]);

  // 대상 요소 위치 추적 (스크롤·레이아웃 변동·늦은 렌더 대응). 변화가 있을 때만 상태 갱신.
  useEffect(() => {
    if (!active || active.screen !== phase) {
      setRect(null);
      return;
    }
    const target = active.target;
    const update = () => {
      const el = document.querySelector(`[data-guide="${target}"]`);
      if (!el) {
        setRect(null);
        return;
      }
      const r = el.getBoundingClientRect();
      setRect((prev) =>
        prev && prev.top === r.top && prev.left === r.left && prev.width === r.width && prev.height === r.height
          ? prev
          : { top: r.top, left: r.left, width: r.width, height: r.height, bottom: r.bottom }
      );
    };
    update();
    const iv = setInterval(update, 200);
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => {
      clearInterval(iv);
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, [active, phase]);

  const endTour = () => {
    try {
      sessionStorage.setItem(GUIDE_SESSION_KEY, "1");
    } catch (e) {
      /* noop */
    }
    setStep(-1);
    onGotoScreen("opinion"); // 안내가 끝나면 작업 시작 지점으로 되돌림
  };

  const next = () => {
    if (step >= TOUR_STEPS.length - 1) {
      endTour();
      return;
    }
    setStep(step + 1);
  };

  if (!active || !rect || active.screen !== phase) return null;

  const below = rect.bottom + 150 < window.innerHeight;
  const centerX = Math.min(Math.max(rect.left + rect.width / 2, 140), window.innerWidth - 140);
  const isLast = step === TOUR_STEPS.length - 1;

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 9998, pointerEvents: "none", fontFamily: "sans-serif" }}>
      {/* 전체를 덮는 모달이 아니라 pointerEvents:none 레이어라 뒤 화면은 그대로 조작 가능 */}
      <style>{`@keyframes onalignPulse{0%{box-shadow:0 0 0 0 rgba(114,201,172,.55)}70%{box-shadow:0 0 0 8px rgba(114,201,172,0)}100%{box-shadow:0 0 0 0 rgba(114,201,172,0)}}`}</style>

      <div
        style={{
          position: "absolute",
          top: rect.top - 6,
          left: rect.left - 6,
          width: rect.width + 12,
          height: rect.height + 12,
          border: "2px solid #72c9ac",
          borderRadius: 12,
          boxSizing: "border-box",
          animation: "onalignPulse 1.8s infinite",
        }}
      />

      <div
        style={{
          position: "absolute",
          left: centerX,
          ...(below ? { top: rect.bottom + 14, transform: "translateX(-50%)" } : { top: rect.top - 14, transform: "translate(-50%, -100%)" }),
          width: 250,
          background: "#242322",
          color: "#f2f1ec",
          borderRadius: 12,
          padding: "14px 16px",
          boxShadow: "0 10px 32px rgba(0,0,0,.3)",
          pointerEvents: "auto",
        }}
      >
        <div
          style={{
            position: "absolute",
            left: "50%",
            transform: "translateX(-50%) rotate(45deg)",
            width: 12,
            height: 12,
            background: "#242322",
            ...(below ? { top: -6 } : { bottom: -6 }),
          }}
        />
        <div style={{ fontSize: 11, color: "#8b877f", marginBottom: 6, position: "relative" }}>
          가이드 {step + 1} / {TOUR_STEPS.length}
        </div>
        <div style={{ fontSize: 14, lineHeight: 1.5, marginBottom: 12, position: "relative" }}>{active.text}</div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, position: "relative" }}>
          <button
            onClick={endTour}
            style={{ border: "none", background: "none", color: "#8b877f", fontSize: 12, cursor: "pointer", padding: 0 }}
          >
            건너뛰기
          </button>
          <button
            onClick={next}
            style={{ border: "none", background: "#f2f1ec", color: "#242322", borderRadius: 8, padding: "6px 16px", fontSize: 13, fontWeight: 600, cursor: "pointer" }}
          >
            {isLast ? "시작하기" : "다음"}
          </button>
        </div>
      </div>
    </div>
  );
}

// 1번: 모든 화면 최상단에 고정되는 로고 영역. right에 화면별 우측 콘텐츠(프로필 등)를 넣는다.
function TopBar({ onHome, right }) {
  return (
    <header
      style={{
        position: "sticky",
        top: 0,
        zIndex: 100,
        background: "rgba(251,250,247,0.92)",
        backdropFilter: "blur(6px)",
        WebkitBackdropFilter: "blur(6px)",
        borderBottom: "1px solid #ece9e2",
      }}
    >
      <div
        style={{
          maxWidth: 900,
          margin: "0 auto",
          padding: "10px 16px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
          flexWrap: "wrap",
        }}
      >
        <Logo onClick={onHome} />
        {right}
      </div>
    </header>
  );
}

export default function FacilitationBoard() {
  const [projects, setProjects] = useState(null);
  const [selectedProject, setSelectedProject] = useState(null);
  const [newProjectTitle, setNewProjectTitle] = useState("");
  const [name, setName] = useState(null);
  const [nameInput, setNameInput] = useState("");
  const [board, setBoard] = useState(emptyBoard());
  const [loaded, setLoaded] = useState(false);
  const [justCreatedId, setJustCreatedId] = useState(null);
  const [mergeMode, setMergeMode] = useState(false);
  const [selected, setSelected] = useState([]);
  const [confirmState, setConfirmState] = useState(null); // { title, message, confirmLabel, onConfirm }
  const boardRef = useRef(board);
  boardRef.current = board;
  // 드래그 중이거나 포스트잇을 편집 중일 때는 2초 폴링이 로컬 변경을 덮어쓰지 않도록 잠시 멈춘다
  const suspendPollRef = useRef(false);

  // 프로젝트 인덱스 로드 (목록 화면에서 항상 최신 상태 유지)
  const loadProjects = useCallback(async () => {
    try {
      const res = await storage.get(PROJECTS_INDEX_KEY, true);
      setProjects(res && res.value ? JSON.parse(res.value) : []);
    } catch (e) {
      setProjects([]);
    }
  }, []);

  useEffect(() => {
    loadProjects();
  }, [loadProjects]);

  const createProject = async () => {
    const title = newProjectTitle.trim();
    if (!title) return;
    const project = { id: uid(), title, createdAt: Date.now() };
    const nextList = [project, ...(projects || [])];
    await storage.set(PROJECTS_INDEX_KEY, JSON.stringify(nextList), true);
    await storage.set(boardKeyOf(project.id), JSON.stringify(emptyBoard()), true);
    setProjects(nextList);
    setNewProjectTitle("");
    setSelectedProject(project);
  };

  const deleteProject = async (id) => {
    const nextList = (projects || []).filter((p) => p.id !== id);
    await storage.set(PROJECTS_INDEX_KEY, JSON.stringify(nextList), true);
    await storage.delete(boardKeyOf(id), true).catch(() => {});
    clearSavedName(id);
    setProjects(nextList);
  };

  const backToProjects = () => {
    setSelectedProject(null);
    setName(null);
    setLoaded(false);
    setMergeMode(false);
    setSelected([]);
    setBoard(emptyBoard());
  };

  // 저장소에서 현재 프로젝트의 보드 상태를 읽어옴
  const loadBoard = useCallback(async () => {
    if (!selectedProject) return;
    try {
      const res = await storage.get(boardKeyOf(selectedProject.id), true);
      if (res && res.value) {
        setBoard(normalizeBoard(JSON.parse(res.value)));
      }
    } catch (e) {
      // key not created yet
    }
    setLoaded(true);
  }, [selectedProject]);

  // 보드 상태를 통째로 저장. 여러 하위 키로 쪼개면 동시 수정 시 last-write-wins로 유실될 위험이 커서
  // 하나의 키 안에서 전체 객체를 갱신하는 방식을 쓴다
  const saveBoard = useCallback(
    async (next) => {
      if (!selectedProject) return;
      setBoard(next);
      try {
        await storage.set(boardKeyOf(selectedProject.id), JSON.stringify(next), true);
      } catch (e) {
        console.error("저장 실패", e);
      }
    },
    [selectedProject]
  );

  useEffect(() => {
    if (!selectedProject) return;
    loadBoard();
    // 2초 간격 폴링으로 다른 참여자의 변경사항을 반영 (websocket 없이 유사 실시간 구현)
    // 단, 드래그나 텍스트 편집 중에는 건드리지 않는다 -> 안 그러면 끌던 포스트잇이 튀거나 타이핑 중 내용이 사라짐
    const iv = setInterval(() => {
      if (!suspendPollRef.current) loadBoard();
    }, 2000);
    return () => clearInterval(iv);
  }, [selectedProject, loadBoard]);

  // 이름으로 참여(등록). joinBoard(수동 입력)과 자동 재진입이 함께 쓴다.
  const doJoin = useCallback(
    async (rawName) => {
      const trimmed = (rawName || "").trim();
      if (!trimmed || !selectedProject) return;
      await loadBoard();
      const current = boardRef.current;
      const color = current.users[trimmed] ? current.users[trimmed].color : pickColor(current.users);
      await saveBoard({ ...current, users: { ...current.users, [trimmed]: { color } } });
      setSavedName(selectedProject.id, trimmed); // 2번: 이 브라우저·이 프로젝트에 내 이름 기억
      setName(trimmed);
    },
    [selectedProject, loadBoard, saveBoard]
  );

  const joinBoard = () => doJoin(nameInput);

  // 2번: 같은 브라우저에서 참여한 적 있는 프로젝트면 이름 화면을 건너뛰고 바로 입장
  useEffect(() => {
    if (selectedProject && !name) {
      const saved = getSavedName(selectedProject.id);
      if (saved) doJoin(saved);
    }
    // name을 의존성에 넣지 않는다: 자동 입장 후 재실행/루프 방지
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedProject]);

  // 2번: 다른 이름으로 다시 참여하고 싶을 때 -> 기억된 이름을 지우고 이름 화면으로
  const changeName = () => {
    if (selectedProject) clearSavedName(selectedProject.id);
    setName(null);
    setNameInput("");
    setMergeMode(false);
    setSelected([]);
  };

  const myColor = name && board.users[name] ? board.users[name].color : PALETTE[0];

  // 새 포스트잇을 지정된 의견 보드(topic) 맨 아래에 추가한다. 배열의 뒤쪽에 붙이는 것만으로
  // "추가하면 하단에 생기는" 순서가 자연스럽게 보장된다 (별도 좌표 계산이 필요 없음)
  const createBlankNote = async (topicId) => {
    if (!name) return;
    await loadBoard();
    const current = boardRef.current;
    const note = { id: uid(), text: "", authors: [name], topicId, isProblem: false };
    await saveBoard({ ...current, notes: [...current.notes, note] });
    setJustCreatedId(note.id);
  };

  // 새 의견 보드(주제) 추가
  const addTopic = async () => {
    await loadBoard();
    const current = boardRef.current;
    const topic = { id: uid(), title: `의견${current.topics.length + 1}` };
    await saveBoard({ ...current, topics: [...current.topics, topic] });
  };

  const renameTopic = async (id, title) => {
    await loadBoard();
    const current = boardRef.current;
    await saveBoard({ ...current, topics: current.topics.map((t) => (t.id === id ? { ...t, title } : t)) });
  };

  // 3번: 의견 보드 삭제. 빈 보드는 바로 삭제, 포스트잇이 있으면 확인 팝업을 거친다.
  const deleteTopic = async (topicId) => {
    await loadBoard();
    const current = boardRef.current;
    const removedIds = current.notes.filter((n) => n.topicId === topicId).map((n) => n.id);
    const votes = { ...current.votes };
    removedIds.forEach((id) => delete votes[id]);
    await saveBoard({
      ...current,
      topics: current.topics.filter((t) => t.id !== topicId),
      notes: current.notes.filter((n) => n.topicId !== topicId),
      votes,
    });
  };

  const requestDeleteTopic = (topic) => {
    const hasNotes = board.notes.some((n) => n.topicId === topic.id);
    if (!hasNotes) {
      deleteTopic(topic.id);
      return;
    }
    setConfirmState({
      title: "의견 보드 삭제",
      message: "의견이 아직 남아있습니다. 삭제하시겠습니까?",
      confirmLabel: "삭제",
      onConfirm: () => {
        deleteTopic(topic.id);
        setConfirmState(null);
      },
    });
  };

  const updateInstructions = async (text) => {
    await loadBoard();
    const current = boardRef.current;
    await saveBoard({ ...current, instructions: text });
  };

  // 포스트잇 내용을 타이핑하는 동안은 로컬 상태만 갱신 (폴링에 의해 지워지지 않도록)
  const editNoteTextLocal = (id, text) => {
    setBoard((prev) => ({
      ...prev,
      notes: prev.notes.map((n) => (n.id === id ? { ...n, text } : n)),
    }));
  };

  // 편집을 마치고 포커스를 벗어날 때(blur) 최신 원격 상태 위에 내 텍스트만 반영해 저장
  const commitNoteText = async (id) => {
    const myText = boardRef.current.notes.find((n) => n.id === id)?.text ?? "";
    await loadBoard();
    const current = boardRef.current;
    await saveBoard({
      ...current,
      notes: current.notes.map((n) => (n.id === id ? { ...n, text: myText } : n)),
    });
  };

  // 서로 다른 의견 보드(topic)에 속한 포스트잇은 함께 선택할 수 없게 막는다 -> 병합은 같은 주제 안에서만 의미가 있음
  const toggleSelect = (id, topicId) => {
    setSelected((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      if (prev.length > 0) {
        const firstTopic = board.notes.find((n) => n.id === prev[0])?.topicId;
        if (firstTopic !== topicId) return prev;
      }
      return [...prev, id];
    });
  };

  const mergeSelected = async () => {
    if (selected.length < 2) return;
    await loadBoard();
    const current = boardRef.current;
    const chosen = current.notes.filter((n) => selected.includes(n.id));
    const rest = current.notes.filter((n) => !selected.includes(n.id));
    const votes = { ...current.votes };
    selected.forEach((id) => delete votes[id]); // 병합되어 사라지는 노트의 표는 정리
    const merged = {
      id: uid(),
      text: chosen.map((n) => n.text).join(" / "),
      authors: [...new Set(chosen.flatMap((n) => n.authors))],
      topicId: chosen[0].topicId,
      isProblem: false,
    };
    await saveBoard({ ...current, notes: [...rest, merged], votes });
    setSelected([]);
    setMergeMode(false);
  };

  const deleteNote = async (id) => {
    await loadBoard();
    const current = boardRef.current;
    const votes = { ...current.votes };
    delete votes[id];
    await saveBoard({ ...current, notes: current.notes.filter((n) => n.id !== id), votes });
  };

  // 6번: "문제로" 토글. 노트 자체에 isProblem을 표시(복제 없음). 해제 시 그 노트의 표는 정리.
  const toggleProblem = async (noteId) => {
    await loadBoard();
    const current = boardRef.current;
    const target = current.notes.find((n) => n.id === noteId);
    const willBeProblem = !target?.isProblem;
    const votes = { ...current.votes };
    if (!willBeProblem) delete votes[noteId];
    await saveBoard({
      ...current,
      notes: current.notes.map((n) => (n.id === noteId ? { ...n, isProblem: willBeProblem } : n)),
      votes,
    });
  };

  const setPhase = async (phase) => {
    await loadBoard();
    const current = boardRef.current;
    await saveBoard({ ...current, phase });
  };

  // 사용자별 총 투표 수를 계산 (여러 항목에 분산 가능, 단 항목당 1표로 제한)
  const myVoteCount = (b) =>
    Object.values(b.votes).reduce((sum, voters) => sum + (voters.includes(name) ? 1 : 0), 0);

  // 핵심 제약: 동일 인물이 같은 포스트잇에 중복 투표 불가(토글로 취소만 가능),
  // 전체 투표권(votesPerUser) 소진 시 새 항목에 투표 불가. 이제 note.id 기준.
  const toggleVote = async (noteId) => {
    if (!name) return;
    await loadBoard();
    const current = boardRef.current;
    const votersNow = current.votes[noteId] || [];
    const already = votersNow.includes(name);
    let nextVoters;
    if (already) {
      nextVoters = votersNow.filter((v) => v !== name);
    } else {
      if (myVoteCount(current) >= current.votesPerUser) return;
      nextVoters = [...votersNow, name];
    }
    await saveBoard({ ...current, votes: { ...current.votes, [noteId]: nextVoters } });
  };

  const setVotesPerUser = async (n) => {
    await loadBoard();
    const current = boardRef.current;
    await saveBoard({ ...current, votesPerUser: n });
  };

  const downloadSummaryImage = () => {
    const canvas = renderSummaryCanvas(selectedProject, board);
    const link = document.createElement("a");
    link.download = `${selectedProject.title}-요약.png`;
    link.href = canvas.toDataURL("image/png");
    link.click();
  };

  // 4번(문서): 표 중심 문서를 HTML 파일로 내려받기
  const downloadDoc = () => {
    const html = buildDocHtml(selectedProject, board);
    const blob = new Blob([html], { type: "text/html;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.download = `${selectedProject.title}-문서.html`;
    link.href = url;
    link.click();
    URL.revokeObjectURL(url);
  };

  // ---- 화면 1: 프로젝트 목록 / 생성 ----
  if (!selectedProject) {
    return (
      <div>
        <TopBar onHome={backToProjects} />
        <div style={{ maxWidth: 520, margin: "0 auto", padding: 24, fontFamily: "sans-serif" }}>
          <div style={{ fontSize: 20, fontWeight: 600, marginBottom: 4 }}>퍼실리테이션 보드</div>
          <div style={{ fontSize: 13, color: "#888", marginBottom: 24 }}>
            프로젝트별로 진행 내용이 저장됩니다. 이전 프로젝트는 언제든 다시 열어볼 수 있어요.
          </div>
          <div style={{ display: "flex", gap: 8, marginBottom: 24 }}>
            <input
              value={newProjectTitle}
              onChange={(e) => setNewProjectTitle(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && createProject()}
              placeholder="새 프로젝트 이름 (예: 2026년 3분기 회고)"
              style={{ flex: 1, padding: "8px 12px", borderRadius: 8, border: "1px solid #ddd", fontSize: 14 }}
            />
            <button
              onClick={createProject}
              style={{ padding: "8px 16px", borderRadius: 8, border: "none", background: "#2c2c2c", color: "white", cursor: "pointer", whiteSpace: "nowrap" }}
            >
              + 새 프로젝트
            </button>
          </div>
          {projects === null && <div style={{ color: "#aaa", fontSize: 13 }}>불러오는 중...</div>}
          {projects && projects.length === 0 && (
            <div style={{ color: "#aaa", fontSize: 13 }}>아직 생성된 프로젝트가 없습니다.</div>
          )}
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {projects &&
              projects.map((p) => (
                <div
                  key={p.id}
                  style={{
                    border: "1px solid #eee",
                    borderRadius: 8,
                    padding: "10px 14px",
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    cursor: "pointer",
                    background: "#fff",
                  }}
                  onClick={() => setSelectedProject(p)}
                >
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 500 }}>{p.title}</div>
                    <div style={{ fontSize: 12, color: "#999" }}>
                      {new Date(p.createdAt).toLocaleDateString("ko-KR")} 생성
                    </div>
                  </div>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setConfirmState({
                        title: "프로젝트 삭제",
                        message: `'${p.title}' 프로젝트를 삭제하시겠습니까?`,
                        confirmLabel: "삭제",
                        onConfirm: () => {
                          deleteProject(p.id);
                          setConfirmState(null);
                        },
                      });
                    }}
                    style={{ border: "none", background: "rgba(0,0,0,0.06)", borderRadius: 4, fontSize: 11, padding: "4px 8px", cursor: "pointer" }}
                  >
                    삭제
                  </button>
                </div>
              ))}
          </div>
        </div>
        <ConfirmDialog
          open={!!confirmState}
          title={confirmState?.title}
          message={confirmState?.message}
          confirmLabel={confirmState?.confirmLabel}
          onConfirm={confirmState?.onConfirm}
          onCancel={() => setConfirmState(null)}
        />
      </div>
    );
  }

  // ---- 화면 2: 참여자 이름 입력 ----
  if (!name) {
    return (
      <div>
        <TopBar onHome={backToProjects} />
        <div style={{ maxWidth: 420, margin: "40px auto", padding: 32, fontFamily: "sans-serif", textAlign: "center" }}>
          <div style={{ fontSize: 18, fontWeight: 600, marginBottom: 4 }}>{selectedProject.title}</div>
          <div style={{ fontSize: 14, color: "#777", marginBottom: 24 }}>
            이름이나 닉네임을 입력하면 참여할 수 있어요. 색상은 자동으로 배정됩니다.
          </div>
          <input
            value={nameInput}
            onChange={(e) => setNameInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && joinBoard()}
            placeholder="이름 또는 닉네임"
            style={{ width: "100%", padding: "10px 14px", fontSize: 15, borderRadius: 8, border: "1px solid #ddd", marginBottom: 12, boxSizing: "border-box" }}
          />
          <button
            onClick={joinBoard}
            style={{ width: "100%", padding: "10px 14px", fontSize: 15, borderRadius: 8, border: "none", background: "#2c2c2c", color: "white", cursor: "pointer" }}
          >
            참여하기
          </button>
        </div>
      </div>
    );
  }

  const votesLeft = board.votesPerUser - myVoteCount(board);
  const problemNotesAll = board.notes.filter((n) => n.isProblem);
  const rankedProblems = [...problemNotesAll].sort(
    (a, b) => (board.votes[b.id]?.length || 0) - (board.votes[a.id]?.length || 0)
  );
  const docModel = buildDocModel(selectedProject, board);

  // 포스트잇 카드 렌더 (문제 그룹/일반 그룹에서 공통 사용)
  const renderNoteCard = (note) => {
    const isSel = selected.includes(note.id);
    const noteColor = board.users[note.authors[0]]?.color || PALETTE[0];
    const voters = board.votes[note.id] || [];
    const iVoted = voters.includes(name);
    const voteDisabled = !iVoted && votesLeft <= 0;
    return (
      <div
        key={note.id}
        onClick={() => mergeMode && toggleSelect(note.id, note.topicId)}
        style={{
          width: 220,
          maxWidth: "100%",
          background: noteColor.bg,
          color: noteColor.text,
          borderRadius: 6,
          boxShadow: isSel ? "0 0 0 2px #333" : "none",
          border: note.isProblem ? "2px solid #d4537e" : "1px solid rgba(0,0,0,0.06)",
          cursor: mergeMode ? "pointer" : "default",
          display: "flex",
          flexDirection: "column",
          boxSizing: "border-box",
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            padding: "6px 10px 0",
            fontSize: 11,
            opacity: 0.7,
          }}
        >
          <span style={{ display: "flex", alignItems: "center", gap: 3 }}>
            {note.isProblem && <span title="문제로 표시됨">📌</span>}
            {note.authors.join(", ")}
          </span>
          {!mergeMode && (
            <span
              onClick={(e) => {
                e.stopPropagation();
                deleteNote(note.id);
              }}
              style={{ cursor: "pointer", padding: "0 4px" }}
              title="삭제"
            >
              ×
            </span>
          )}
        </div>

        {/* 4번: 병합 모드에서는 disabled textarea 대신 읽기전용 div로 렌더 -> 카드 전체 클릭 선택 가능 */}
        {mergeMode ? (
          <div
            style={{
              padding: "4px 10px 8px",
              fontSize: 14,
              lineHeight: 1.4,
              color: noteColor.text,
              minHeight: 22,
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
            }}
          >
            {note.text || <span style={{ opacity: 0.5 }}>(빈 포스트잇)</span>}
          </div>
        ) : (
          <textarea
            autoFocus={justCreatedId === note.id}
            value={note.text}
            placeholder="자유롭게 적어보세요"
            ref={(el) => autoResizeTextarea(el)}
            onChange={(e) => {
              editNoteTextLocal(note.id, e.target.value);
              autoResizeTextarea(e.target);
            }}
            onFocus={() => {
              suspendPollRef.current = true;
            }}
            onBlur={() => {
              suspendPollRef.current = false;
              commitNoteText(note.id);
              setJustCreatedId(null);
            }}
            style={{
              width: "100%",
              border: "none",
              background: "transparent",
              resize: "none",
              overflow: "hidden",
              outline: "none",
              fontFamily: "sans-serif",
              fontSize: 14,
              lineHeight: 1.4,
              color: noteColor.text,
              padding: "4px 10px 8px",
              boxSizing: "border-box",
              wordBreak: "break-word",
            }}
          />
        )}

        {!mergeMode && (
          <div style={{ padding: "0 8px 8px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6 }}>
            <button
              onClick={(e) => {
                e.stopPropagation();
                toggleProblem(note.id);
              }}
              title={note.isProblem ? "문제 표시 해제" : "문제로 표시"}
              style={{
                border: "none",
                background: note.isProblem ? "#d4537e" : "rgba(0,0,0,0.12)",
                color: note.isProblem ? "#fff" : noteColor.text,
                borderRadius: 4,
                fontSize: 10,
                padding: "3px 8px",
                cursor: "pointer",
                fontWeight: 600,
              }}
            >
              {note.isProblem ? "문제 해제" : "문제로"}
            </button>
            {/* 7번: 문제로 표시된 포스트잇에 바로 투표 */}
            {note.isProblem && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  toggleVote(note.id);
                }}
                disabled={voteDisabled}
                title={voteDisabled ? "남은 투표권이 없습니다" : "투표"}
                style={{
                  border: "none",
                  background: iVoted ? "#2c2c2c" : "rgba(0,0,0,0.12)",
                  color: iVoted ? "#fff" : noteColor.text,
                  borderRadius: 999,
                  fontSize: 11,
                  padding: "3px 10px",
                  cursor: voteDisabled ? "default" : "pointer",
                  opacity: voteDisabled ? 0.4 : 1,
                  fontWeight: 600,
                  whiteSpace: "nowrap",
                }}
              >
                {iVoted ? "✓ 투표됨" : "👍 투표"} {voters.length > 0 ? voters.length : ""}
              </button>
            )}
          </div>
        )}
      </div>
    );
  };

  // ---- 화면 3: 보드 본체 ----
  return (
    <div>
      <TopBar
        onHome={backToProjects}
        right={
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span
              style={{ background: myColor.bg, color: myColor.text, borderRadius: 999, padding: "4px 12px", fontSize: 13, fontWeight: 600 }}
            >
              {name}
            </span>
            <button
              onClick={changeName}
              style={{ border: "1px solid #ddd", background: "#fff", color: "#666", borderRadius: 999, padding: "4px 10px", fontSize: 12, cursor: "pointer" }}
            >
              다른 이름으로 참여
            </button>
          </div>
        }
      />
      <div style={{ fontFamily: "sans-serif", maxWidth: 900, margin: "0 auto", padding: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16, flexWrap: "wrap", gap: 8 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 15, fontWeight: 600 }}>{selectedProject.title}</span>
            <span style={{ fontSize: 12, color: "#999" }}>참여자 {Object.keys(board.users).length}명</span>
          </div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {[
              { key: "opinion", label: "의견 작성" },
              { key: "problem", label: "문제 정리" },
              { key: "voting", label: "우선순위별 결과" },
              { key: "document", label: "문서" },
            ].map((tab) => (
              <button
                key={tab.key}
                onClick={() => setPhase(tab.key)}
                style={{
                  padding: "6px 14px",
                  borderRadius: 999,
                  border: "1px solid #ddd",
                  background: board.phase === tab.key ? "#2c2c2c" : "white",
                  color: board.phase === tab.key ? "white" : "#333",
                  fontSize: 13,
                  cursor: "pointer",
                }}
              >
                {tab.label}
              </button>
            ))}
            <button
              data-guide="save-image"
              onClick={downloadSummaryImage}
              style={{ padding: "6px 14px", borderRadius: 999, border: "1px solid #ddd", background: "white", color: "#333", fontSize: 13, cursor: "pointer" }}
            >
              이미지로 저장
            </button>
          </div>
        </div>

        {board.phase === "opinion" && (
          <div>
            {/* 안내 문구 배너: 글자 수에 맞춰 세로 길이가 자동으로 늘어나 잘리거나 스크롤이 생기지 않는다 */}
            <div style={{ background: "#242322", color: "#f2f1ec", borderRadius: 10, padding: "16px 18px", marginBottom: 14 }}>
              <textarea
                defaultValue={board.instructions}
                ref={(el) => autoResizeTextarea(el)}
                onInput={(e) => autoResizeTextarea(e.target)}
                onFocus={() => {
                  suspendPollRef.current = true;
                }}
                onBlur={(e) => {
                  suspendPollRef.current = false;
                  updateInstructions(e.target.value);
                }}
                style={{
                  width: "100%",
                  background: "transparent",
                  border: "none",
                  outline: "none",
                  resize: "none",
                  overflow: "hidden",
                  color: "#f2f1ec",
                  fontSize: 13,
                  lineHeight: 1.6,
                  fontFamily: "sans-serif",
                  boxSizing: "border-box",
                }}
              />
            </div>

            {/* 참여자 색상 범례 */}
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 12 }}>
              {Object.entries(board.users).map(([uname, u]) => (
                <span
                  key={uname}
                  style={{ background: u.color.bg, color: u.color.text, borderRadius: 6, padding: "6px 14px", fontSize: 13, fontWeight: 600 }}
                >
                  {uname}
                </span>
              ))}
            </div>

            {/* 7번: 투표는 이 화면에서 이뤄지므로 남은 투표권을 여기에 안내 */}
            <div
              data-guide="vote-status"
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                flexWrap: "wrap",
                background: "#f3f0ea",
                border: "1px solid #e8e6df",
                borderRadius: 8,
                padding: "8px 12px",
                marginBottom: 14,
                fontSize: 13,
                color: "#555",
              }}
            >
              <span>
                투표: 남은 <b>{Math.max(0, votesLeft)}</b> / {board.votesPerUser}표
              </span>
              <span style={{ color: "#999" }}>· 📌 문제로 표시된 포스트잇의 "투표" 버튼으로 투표하세요 (항목당 1표)</span>
            </div>

            <div style={{ display: "flex", gap: 8, marginBottom: 12, alignItems: "center", flexWrap: "wrap" }}>
              <button
                onClick={addTopic}
                style={{ padding: "8px 16px", borderRadius: 8, border: "1px solid #ddd", background: "white", color: "#333", cursor: "pointer", fontSize: 13 }}
              >
                + 의견 보드 추가
              </button>
              <button
                data-guide="merge"
                onClick={() => {
                  setMergeMode((m) => !m);
                  setSelected([]);
                }}
                style={{
                  padding: "8px 16px",
                  borderRadius: 8,
                  border: "1px solid #ddd",
                  background: mergeMode ? "#2c2c2c" : "white",
                  color: mergeMode ? "white" : "#333",
                  cursor: "pointer",
                  fontSize: 13,
                }}
              >
                {mergeMode ? "병합 모드 종료" : "병합 모드"}
              </button>
              {mergeMode ? (
                <span style={{ fontSize: 13, color: "#777" }}>
                  같은 보드 안에서 합칠 포스트잇 2개 이상을 클릭해 선택하세요. 선택됨: {selected.length}개
                  {selected.length >= 2 && (
                    <button
                      onClick={mergeSelected}
                      style={{ marginLeft: 10, padding: "4px 12px", borderRadius: 6, border: "none", background: "#2c2c2c", color: "white", cursor: "pointer", fontSize: 12 }}
                    >
                      선택한 포스트잇 병합
                    </button>
                  )}
                </span>
              ) : (
                <span style={{ fontSize: 12, color: "#aaa" }}>각 보드의 "+ 포스트잇"을 누르면 새 의견이 쌓입니다.</span>
              )}
            </div>

            {/* 의견 보드들을 세로로 쌓는다. 각 보드 안에서 포스트잇은 좌->우로 채워지고 줄이 차면 다음 줄로(5번). */}
            <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
              {board.topics.map((topic, topicIdx) => {
                const topicNotes = board.notes.filter((n) => n.topicId === topic.id);
                const problemNotes = topicNotes.filter((n) => n.isProblem); // 6번: 상단 고정
                const normalNotes = topicNotes.filter((n) => !n.isProblem);
                const canDelete = board.topics.length > 1;
                return (
                  <div key={topic.id} style={{ width: "100%" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6, gap: 8 }}>
                      <input
                        defaultValue={topic.title}
                        onBlur={(e) => renameTopic(topic.id, e.target.value.trim() || topic.title)}
                        style={{ fontSize: 13, fontWeight: 600, color: "#666", border: "none", background: "transparent", outline: "none", flex: 1, minWidth: 0 }}
                      />
                      <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                        {/* 3번: 보드 삭제 (마지막 1개는 삭제 불가) */}
                        {canDelete && (
                          <button
                            onClick={() => requestDeleteTopic(topic)}
                            title={problemNotes.length + normalNotes.length === 0 ? "빈 보드 삭제" : "보드 삭제"}
                            style={{ border: "1px solid #eee", background: "#fff", color: "#999", borderRadius: 8, padding: "5px 10px", cursor: "pointer", fontSize: 12 }}
                          >
                            보드 삭제
                          </button>
                        )}
                        <button
                          data-guide="add-note"
                          onClick={() => createBlankNote(topic.id)}
                          style={{ padding: "5px 12px", borderRadius: 8, border: "none", background: myColor.bg, color: myColor.text, fontWeight: 600, cursor: "pointer", fontSize: 12 }}
                        >
                          + 포스트잇
                        </button>
                      </div>
                    </div>
                    <div
                      /* 가이드 투어의 '문제로' 단계가 가리키는 대상: 포스트잇 보드 영역(첫 보드 기준) */
                      {...(topicIdx === 0 ? { "data-guide": "note-board" } : {})}
                      style={{
                        display: "flex",
                        flexDirection: "column",
                        gap: 14,
                        background: "#ffffff",
                        border: "1px solid #e8e6df",
                        borderRadius: 10,
                        padding: 14,
                        overflowX: "hidden",
                      }}
                    >
                      {/* 6번: 문제로 표시된 포스트잇을 보드 상단에 고정 */}
                      {problemNotes.length > 0 && (
                        <div>
                          <div style={{ fontSize: 11, fontWeight: 700, color: "#c0392b", marginBottom: 8 }}>📌 문제로 표시된 의견</div>
                          <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>{problemNotes.map(renderNoteCard)}</div>
                        </div>
                      )}
                      {/* 5번: 일반 포스트잇은 flex-wrap으로 좌->우 채우고 줄바꿈 (가로 스크롤 없음) */}
                      {normalNotes.length > 0 && (
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>{normalNotes.map(renderNoteCard)}</div>
                      )}
                      {topicNotes.length === 0 && (
                        <div style={{ color: "#bbb", fontSize: 13, padding: 6 }}>아직 포스트잇이 없습니다.</div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {board.phase === "problem" && (
          <div>
            <div data-guide="problem-area" style={{ fontSize: 13, color: "#666", marginBottom: 16, background: "#f3f0ea", border: "1px solid #e8e6df", borderRadius: 8, padding: "10px 12px" }}>
              여러 의견 보드에서 <b>"문제로"</b> 표시된 포스트잇을 한곳에 모았습니다. 여기서 문구를 다듬으면 원래 보드의 포스트잇도 함께 바뀝니다.
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {problemNotesAll.map((n) => {
                const topicTitle = board.topics.find((t) => t.id === n.topicId)?.title || "";
                return (
                  <div key={n.id} style={{ border: "1px solid #eee", borderRadius: 8, padding: 12, display: "flex", gap: 8, alignItems: "flex-start", background: "#fff" }}>
                    <span style={{ fontSize: 11, color: "#b0623a", flexShrink: 0, marginTop: 6 }} title="원래 의견 보드">
                      📌 {topicTitle}
                    </span>
                    <textarea
                      value={n.text}
                      onChange={(e) => editNoteTextLocal(n.id, e.target.value)}
                      onFocus={() => {
                        suspendPollRef.current = true;
                      }}
                      onBlur={() => {
                        suspendPollRef.current = false;
                        commitNoteText(n.id);
                      }}
                      style={{ flex: 1, border: "none", resize: "vertical", fontSize: 14, fontFamily: "sans-serif", outline: "none", minHeight: 40 }}
                    />
                    <button
                      onClick={() => toggleProblem(n.id)}
                      title="문제 표시 해제 (포스트잇은 유지)"
                      style={{ border: "1px solid #eee", background: "#fff", color: "#999", borderRadius: 4, fontSize: 11, padding: "4px 8px", cursor: "pointer", flexShrink: 0 }}
                    >
                      문제 해제
                    </button>
                  </div>
                );
              })}
            </div>
            {problemNotesAll.length === 0 && (
              <div style={{ color: "#aaa", fontSize: 14 }}>의견 작성 탭에서 포스트잇을 "문제로" 표시하면 여기 모입니다.</div>
            )}
          </div>
        )}

        {board.phase === "voting" && (
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16, fontSize: 13, color: "#666", flexWrap: "wrap", gap: 8 }}>
              <div>득표수가 많은 순으로 정렬된 결과입니다 (읽기 전용). 투표는 "의견 작성" 탭에서 합니다.</div>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span>1인당 투표권</span>
                <input
                  type="number"
                  min={1}
                  max={10}
                  value={board.votesPerUser}
                  onChange={(e) => setVotesPerUser(Number(e.target.value) || 1)}
                  style={{ width: 50, padding: 4, borderRadius: 6, border: "1px solid #ddd" }}
                />
              </div>
            </div>
            <div data-guide="vote-area" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {rankedProblems.map((p, i) => {
                const voters = board.votes[p.id] || [];
                return (
                  <div key={p.id} style={{ border: "1px solid #eee", borderRadius: 8, padding: 12, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, background: i === 0 ? "#fdf3f7" : "#fff" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10, flex: 1, minWidth: 0 }}>
                      <span style={{ fontSize: 15, fontWeight: 700, color: i === 0 ? "#d4537e" : "#999", width: 20, textAlign: "center", flexShrink: 0 }}>{i + 1}</span>
                      <span style={{ fontSize: 14 }}>{p.text}</span>
                    </div>
                    <div style={{ display: "flex", gap: 4, flexWrap: "wrap", maxWidth: 160, justifyContent: "flex-end" }}>
                      {voters.map((v) => {
                        const c = board.users[v]?.color || PALETTE[0];
                        return <span key={v} title={v} style={{ width: 14, height: 14, borderRadius: "50%", background: c.bg, border: `1px solid ${c.border}`, display: "inline-block" }} />;
                      })}
                    </div>
                    <div style={{ fontSize: 13, color: "#666", width: 36, textAlign: "right", flexShrink: 0 }}>{voters.length}표</div>
                  </div>
                );
              })}
            </div>
            {rankedProblems.length === 0 && (
              <div style={{ color: "#aaa", fontSize: 14 }}>의견 작성 탭에서 포스트잇을 "문제로" 표시하고 투표하면 여기 순위가 나타납니다.</div>
            )}
          </div>
        )}

        {board.phase === "document" && (
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16, flexWrap: "wrap", gap: 8 }}>
              <div style={{ fontSize: 13, color: "#666" }}>진행 과정과 결과를 표로 정리한 문서입니다.</div>
              <button
                onClick={downloadDoc}
                style={{ padding: "8px 16px", borderRadius: 8, border: "none", background: "#2c2c2c", color: "white", cursor: "pointer", fontSize: 13 }}
              >
                문서 다운로드 (HTML)
              </button>
            </div>

            <DocSection title="1. 개요">
              <DocTable>
                <tbody>
                  <DocKV k="프로젝트명" v={selectedProject.title} />
                  <DocKV k="참여자 수" v={`${docModel.participants.length}명`} />
                  <DocKV k="작성된 의견 수" v={`${board.notes.length}개`} />
                  <DocKV k="문제로 표시된 의견 수" v={`${docModel.problemNotes.length}개`} />
                  <DocKV k="최다 득표" v={docModel.ranked[0] ? `${docModel.ranked[0].text} (${docModel.ranked[0].votes}표)` : "—"} />
                </tbody>
              </DocTable>
            </DocSection>

            <DocSection title="2. 참여자">
              <DocTable>
                <thead>
                  <tr>
                    <DocTh>이름</DocTh>
                    <DocTh>배정 색상</DocTh>
                  </tr>
                </thead>
                <tbody>
                  {docModel.participants.length ? (
                    docModel.participants.map((p) => (
                      <tr key={p.name}>
                        <DocTd>{p.name}</DocTd>
                        <DocTd>
                          <span style={{ background: p.color.bg, color: p.color.text, border: `1px solid ${p.color.border}`, borderRadius: 6, padding: "2px 10px", fontSize: 12, fontWeight: 600 }}>
                            {p.color.name}
                          </span>
                        </DocTd>
                      </tr>
                    ))
                  ) : (
                    <DocEmpty span={2}>참여자가 없습니다.</DocEmpty>
                  )}
                </tbody>
              </DocTable>
            </DocSection>

            <DocSection title="3. 의견 모음 (과정)">
              <DocTable>
                <thead>
                  <tr>
                    <DocTh>주제</DocTh>
                    <DocTh>내용</DocTh>
                    <DocTh>작성자</DocTh>
                  </tr>
                </thead>
                <tbody>
                  {board.notes.length ? (
                    docModel.notesByTopic.flatMap((t) =>
                      t.notes.map((n) => (
                        <tr key={n.id}>
                          <DocTd>{t.title}</DocTd>
                          <DocTd>
                            {n.text || <span style={{ color: "#aaa" }}>(빈 포스트잇)</span>}
                            {n.isProblem && (
                              <span style={{ marginLeft: 6, background: "#fdecec", color: "#c0392b", border: "1px solid #eab5b0", borderRadius: 6, padding: "1px 7px", fontSize: 11, fontWeight: 600 }}>문제</span>
                            )}
                          </DocTd>
                          <DocTd>{n.authors.join(", ")}</DocTd>
                        </tr>
                      ))
                    )
                  ) : (
                    <DocEmpty span={3}>작성된 의견이 없습니다.</DocEmpty>
                  )}
                </tbody>
              </DocTable>
            </DocSection>

            <DocSection title="4. 문제로 표시된 의견">
              <DocTable>
                <thead>
                  <tr>
                    <DocTh>#</DocTh>
                    <DocTh>문제</DocTh>
                    <DocTh>작성자</DocTh>
                  </tr>
                </thead>
                <tbody>
                  {docModel.problemNotes.length ? (
                    docModel.problemNotes.map((n, i) => (
                      <tr key={n.id}>
                        <DocTd>{i + 1}</DocTd>
                        <DocTd>{n.text}</DocTd>
                        <DocTd>{n.authors.join(", ")}</DocTd>
                      </tr>
                    ))
                  ) : (
                    <DocEmpty span={3}>문제로 표시된 의견이 없습니다.</DocEmpty>
                  )}
                </tbody>
              </DocTable>
            </DocSection>

            <DocSection title="5. 우선순위별 결과">
              <DocTable>
                <thead>
                  <tr>
                    <DocTh>순위</DocTh>
                    <DocTh>문제</DocTh>
                    <DocTh>득표</DocTh>
                    <DocTh>투표자</DocTh>
                  </tr>
                </thead>
                <tbody>
                  {docModel.ranked.length ? (
                    docModel.ranked.map((p, i) => (
                      <tr key={p.id} style={i === 0 ? { background: "#fdf3f7" } : undefined}>
                        <DocTd>{i + 1}</DocTd>
                        <DocTd>{p.text}</DocTd>
                        <DocTd>{p.votes}표</DocTd>
                        <DocTd>{p.voters.join(", ") || "—"}</DocTd>
                      </tr>
                    ))
                  ) : (
                    <DocEmpty span={4}>결과가 없습니다.</DocEmpty>
                  )}
                </tbody>
              </DocTable>
            </DocSection>
          </div>
        )}
      </div>

      <GuideCoach phase={board.phase} onGotoScreen={setPhase} />
      <ConfirmDialog
        open={!!confirmState}
        title={confirmState?.title}
        message={confirmState?.message}
        confirmLabel={confirmState?.confirmLabel}
        onConfirm={confirmState?.onConfirm}
        onCancel={() => setConfirmState(null)}
      />
    </div>
  );
}

// ---- 문서 뷰용 표 컴포넌트 (앱 내 표시용) ----
function DocSection({ title, children }) {
  return (
    <div style={{ marginBottom: 28 }}>
      <div style={{ fontSize: 16, fontWeight: 700, margin: "0 0 10px", paddingBottom: 6, borderBottom: "2px solid #eee" }}>{title}</div>
      {children}
    </div>
  );
}
function DocTable({ children }) {
  return <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>{children}</table>;
}
function DocTh({ children }) {
  return <th style={{ border: "1px solid #e8e6df", padding: "9px 12px", textAlign: "left", background: "#f5f2ec", fontWeight: 700 }}>{children}</th>;
}
function DocTd({ children }) {
  return <td style={{ border: "1px solid #e8e6df", padding: "9px 12px", textAlign: "left", verticalAlign: "top" }}>{children}</td>;
}
function DocKV({ k, v }) {
  return (
    <tr>
      <th style={{ border: "1px solid #e8e6df", padding: "9px 12px", textAlign: "left", background: "#faf9f6", width: 160, whiteSpace: "nowrap" }}>{k}</th>
      <DocTd>{v}</DocTd>
    </tr>
  );
}
function DocEmpty({ span, children }) {
  return (
    <tr>
      <td colSpan={span} style={{ border: "1px solid #e8e6df", padding: "9px 12px", color: "#aaa" }}>
        {children}
      </td>
    </tr>
  );
}
