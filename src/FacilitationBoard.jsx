import { useState, useEffect, useRef, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { toPng } from "html-to-image";
import { storage } from "./storage";
import Logo from "./components/Logo";
import ConfirmDialog from "./components/ConfirmDialog";

// 화면 전환/요소 추가·삭제에 공통으로 쓰는 트랜지션 프리셋 (애플 스타일의 부드러운 완급 곡선).
// 앞으로 새 화면·리스트를 추가할 때도 이 프리셋을 그대로 재사용한다.
const EASE = [0.22, 1, 0.36, 1];
// 탭(화면) 전환용: 나가는 화면은 absolute로 빠지면서 슬라이드-아웃, 들어오는 화면은 동시에 슬라이드-인 (교차 페이드).
// mode="wait"로 순서를 기다리면 빈 화면이 잠깐 끼어들어 오히려 끊겨 보이므로, 겹치며 자리를 바꾸는 방식을 쓴다.
const fadeSlide = {
  initial: { opacity: 0, x: 24 },
  animate: { opacity: 1, x: 0, position: "relative", transition: { duration: 0.32, ease: EASE } },
  exit: { opacity: 0, x: -24, position: "absolute", transition: { duration: 0.32, ease: EASE } },
  style: { width: "100%" },
};
const popIn = {
  layout: true,
  initial: { opacity: 0, scale: 0.92 },
  animate: { opacity: 1, scale: 1 },
  exit: { opacity: 0, scale: 0.92 },
  transition: { duration: 0.18, ease: EASE },
};

// "이미지로 저장" 파일명에 쓰는 탭별 한글 라벨
const PHASE_LABELS = { opinion: "의견작성", problem: "문제정리", voting: "우선순위결과", document: "문서" };

const PALETTE = [
  { name: "pink", bg: "#ffd3e6", border: "#ff8fbf", text: "#8a1f56" },
  { name: "olive", bg: "#e3f2c1", border: "#a3d977", text: "#3c6b1f" },
  { name: "blue", bg: "#c7e6ff", border: "#7ab8f5", text: "#1a4a80" },
  { name: "purple", bg: "#e6d9ff", border: "#b899f2", text: "#5b2f8a" },
  { name: "tan", bg: "#ffe1b0", border: "#ffbc5c", text: "#8a5416" },
  { name: "teal", bg: "#b8f2e2", border: "#5cd6b3", text: "#146b53" },
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
  const topRanked = ranked.slice(0, 5);
  return { participants, notesByTopic, problemNotes, ranked, topRanked };
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

// 다운로드용 자립형 HTML 문서 문자열 생성 (브라우저에서 바로 열람·인쇄 가능)
// docType: "process"(과정 전체) | "result"(우선순위 TOP 5 결과만)
function buildDocHtml(project, board, docType = "process") {
  const { participants, notesByTopic, problemNotes, ranked, topRanked } = buildDocModel(project, board);
  const dateStr = new Date().toLocaleString("ko-KR");
  const topVote = ranked[0];

  const style = `
  body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Malgun Gothic",sans-serif;color:#242424;max-width:860px;margin:0 auto;padding:40px 24px;line-height:1.6}
  h1{font-size:26px;margin:0 0 4px}
  .sub{color:#888;font-size:13px;margin-bottom:32px}
  h2{font-size:18px;margin:36px 0 12px;padding-bottom:6px;border-bottom:2px solid #eee}
  table{width:100%;border-collapse:collapse;font-size:14px}
  th,td{border:1px solid #e0e0e0;padding:9px 12px;text-align:left;vertical-align:top}
  thead th{background:#e9e9e9;font-weight:700}
  tbody th{background:#f2f2f2;width:160px;white-space:nowrap}
  .chip{display:inline-block;border-radius:6px;padding:2px 10px;font-size:12px;font-weight:600}
  .empty{color:#aaa}
  .rank1 td{background:#fdf3f7}
  .desc{color:#777;font-size:12.5px;margin-top:3px}
  footer{margin-top:40px;color:#aaa;font-size:12px;text-align:center}`;

  if (docType === "result") {
    const overviewRows = [
      ["프로젝트명", esc(project.title)],
      ["문서 생성일시", esc(dateStr)],
      ["문제로 표시된 의견 수", `${problemNotes.length}개`],
      ["최다 득표", topVote ? `${esc(topVote.text)} (${topVote.votes}표)` : "—"],
    ]
      .map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`)
      .join("");

    const topRows = topRanked.length
      ? topRanked
          .map(
            (p, i) =>
              `<tr${i === 0 ? ' class="rank1"' : ""}><td>${i + 1}</td><td>${esc(p.text)}${p.description ? `<div class="desc">설명: ${esc(p.description)}</div>` : ""}</td><td>${p.votes}표</td><td>${esc(p.voters.join(", ")) || "—"}</td></tr>`
          )
          .join("")
      : `<tr><td colspan="4" class="empty">결과가 없습니다.</td></tr>`;

    return `<!DOCTYPE html>
<html lang="ko"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>${esc(project.title)} — 결과 문서</title>
<style>${style}</style></head><body>
<h1>${esc(project.title)}</h1>
<div class="sub">Onalign 퍼실리테이션 결과 문서 · ${esc(dateStr)}</div>

<h2>1. 개요</h2>
<table><tbody>${overviewRows}</tbody></table>

<h2>2. 우선순위 TOP 5 결과</h2>
<table><thead><tr><th>순위</th><th>문제</th><th>득표</th><th>투표자</th></tr></thead><tbody>${topRows}</tbody></table>

<footer>Generated by Onalign</footer>
</body></html>`;
  }

  // docType === "process": 과정 전체 (개요·참여자·의견 모음·문제 정리)
  const overviewRows = [
    ["프로젝트명", esc(project.title)],
    ["문서 생성일시", esc(dateStr)],
    ["참여자 수", `${participants.length}명`],
    ["작성된 의견 수", `${board.notes.length}개`],
    ["문제로 표시된 의견 수", `${problemNotes.length}개`],
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
        .map(
          (n, i) =>
            `<tr><td>${i + 1}</td><td>${esc(n.text)}${n.description ? `<div class="desc">설명: ${esc(n.description)}</div>` : ""}</td><td>${esc(n.authors.join(", "))}</td></tr>`
        )
        .join("")
    : `<tr><td colspan="3" class="empty">문제로 표시된 의견이 없습니다.</td></tr>`;

  return `<!DOCTYPE html>
<html lang="ko"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>${esc(project.title)} — 과정 문서</title>
<style>${style}</style></head><body>
<h1>${esc(project.title)}</h1>
<div class="sub">Onalign 퍼실리테이션 과정 문서 · ${esc(dateStr)}</div>

<h2>1. 개요</h2>
<table><tbody>${overviewRows}</tbody></table>

<h2>2. 참여자</h2>
<table><thead><tr><th>이름</th><th>배정 색상</th></tr></thead><tbody>${participantRows}</tbody></table>

<h2>3. 의견 모음 (과정)</h2>
<table><thead><tr><th>주제</th><th>내용</th><th>작성자</th></tr></thead><tbody>${opinionRows}</tbody></table>

<h2>4. 문제 정리 및 부가 설명</h2>
<table><thead><tr><th>#</th><th>문제</th><th>작성자</th></tr></thead><tbody>${problemRows}</tbody></table>

<footer>Generated by Onalign</footer>
</body></html>`;
}

function mdEsc(s) {
  return String(s ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>");
}

// 다운로드용 마크다운 문서 문자열 생성 (노션·구글독스 등에 붙여넣기 좋은 표 형식)
function buildDocMarkdown(project, board, docType = "process") {
  const { participants, notesByTopic, problemNotes, ranked, topRanked } = buildDocModel(project, board);
  const dateStr = new Date().toLocaleString("ko-KR");
  const topVote = ranked[0];

  if (docType === "result") {
    const overviewRows = [
      ["프로젝트명", project.title],
      ["문서 생성일시", dateStr],
      ["문제로 표시된 의견 수", `${problemNotes.length}개`],
      ["최다 득표", topVote ? `${topVote.text} (${topVote.votes}표)` : "—"],
    ]
      .map(([k, v]) => `| ${mdEsc(k)} | ${mdEsc(v)} |`)
      .join("\n");

    const topRows = topRanked.length
      ? topRanked
          .map((p, i) => {
            const text = p.description ? `${p.text} (설명: ${p.description})` : p.text;
            return `| ${i + 1} | ${mdEsc(text)} | ${p.votes}표 | ${mdEsc(p.voters.join(", ")) || "—"} |`;
          })
          .join("\n")
      : `| - | 결과가 없습니다. | - | - |`;

    return `# ${project.title}

Onalign 퍼실리테이션 결과 문서 · ${dateStr}

## 1. 개요

| 항목 | 내용 |
| --- | --- |
${overviewRows}

## 2. 우선순위 TOP 5 결과

| 순위 | 문제 | 득표 | 투표자 |
| --- | --- | --- | --- |
${topRows}

---
Generated by Onalign
`;
  }

  // docType === "process": 과정 전체 (개요·참여자·의견 모음·문제 정리)
  const overviewRows = [
    ["프로젝트명", project.title],
    ["문서 생성일시", dateStr],
    ["참여자 수", `${participants.length}명`],
    ["작성된 의견 수", `${board.notes.length}개`],
    ["문제로 표시된 의견 수", `${problemNotes.length}개`],
  ]
    .map(([k, v]) => `| ${mdEsc(k)} | ${mdEsc(v)} |`)
    .join("\n");

  const participantRows = participants.length
    ? participants.map((p) => `| ${mdEsc(p.name)} | ${p.color.name} |`).join("\n")
    : `| - | 참여자가 없습니다. |`;

  const opinionRows = board.notes.length
    ? notesByTopic
        .flatMap((t) =>
          t.notes.map((n) => {
            const text = (n.text || "(빈 포스트잇)") + (n.isProblem ? " `문제`" : "");
            return `| ${mdEsc(t.title)} | ${mdEsc(text)} | ${mdEsc(n.authors.join(", "))} |`;
          })
        )
        .join("\n")
    : `| - | 작성된 의견이 없습니다. | - |`;

  const problemRows = problemNotes.length
    ? problemNotes
        .map((n, i) => {
          const text = n.description ? `${n.text} (설명: ${n.description})` : n.text;
          return `| ${i + 1} | ${mdEsc(text)} | ${mdEsc(n.authors.join(", "))} |`;
        })
        .join("\n")
    : `| - | 문제로 표시된 의견이 없습니다. | - |`;

  return `# ${project.title}

Onalign 퍼실리테이션 과정 문서 · ${dateStr}

## 1. 개요

| 항목 | 내용 |
| --- | --- |
${overviewRows}

## 2. 참여자

| 이름 | 배정 색상 |
| --- | --- |
${participantRows}

## 3. 의견 모음 (과정)

| 주제 | 내용 | 작성자 |
| --- | --- | --- |
${opinionRows}

## 4. 문제 정리 및 부가 설명

| # | 문제 | 작성자 |
| --- | --- | --- |
${problemRows}

---
Generated by Onalign
`;
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
  { target: "doc-type-process", screen: "document", text: "과정 문서에서는 의견 작성부터 문제 정리까지의 진행 과정을 확인할 수 있어요" },
  { target: "doc-type-result", screen: "document", text: "결과 문서(문제 우선순위 TOP 5)에서는 최종 우선순위 TOP 5만 간추려 볼 수 있어요" },
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

      {active.target !== "vote-area" && (
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
      )}

      <motion.div
        key={step}
        initial={{ opacity: 0, scale: 0.92 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.2, ease: EASE }}
        style={{
          position: "absolute",
          left: centerX,
          ...(below ? { top: rect.bottom + 14, transform: "translateX(-50%)" } : { top: rect.top - 14, transform: "translate(-50%, -100%)" }),
          width: 250,
          background: "#242424",
          color: "#f2f2f2",
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
            background: "#242424",
            ...(below ? { top: -6 } : { bottom: -6 }),
          }}
        />
        <div style={{ fontSize: 11, color: "#8a8a8a", marginBottom: 6, position: "relative" }}>
          가이드 {step + 1} / {TOUR_STEPS.length}
        </div>
        <div style={{ fontSize: 14, lineHeight: 1.5, marginBottom: 12, position: "relative" }}>{active.text}</div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, position: "relative" }}>
          <button
            onClick={endTour}
            style={{ border: "none", background: "none", color: "#8a8a8a", fontSize: 12, cursor: "pointer", padding: 0 }}
          >
            건너뛰기
          </button>
          <button
            onClick={next}
            style={{ border: "none", background: "#f2f2f2", color: "#242424", borderRadius: 8, padding: "6px 16px", fontSize: 13, fontWeight: 600, cursor: "pointer" }}
          >
            {isLast ? "시작하기" : "다음"}
          </button>
        </div>
      </motion.div>
    </div>
  );
}

// 1번: 모든 화면 최상단에 고정되는 로고 영역. 로고는 랜딩 페이지(첫 화면)로,
// "내 프로젝트"는 앱 내 프로젝트 목록 화면으로 이동한다. right에 화면별 우측 콘텐츠(프로필 등)를 넣는다.
// onSaveImage가 주어지면(보드 화면에서만) "내 프로젝트" 옆에 "이미지로 저장"을 같은 텍스트 스타일로 붙인다.
function TopBar({ onProjects, onSaveImage, right }) {
  const goHome = () => {
    window.location.href = "/";
  };
  const navLinkStyle = { border: "none", background: "none", color: "#777", fontSize: 13, fontWeight: 600, cursor: "pointer", padding: 0 };
  return (
    <header
      style={{
        position: "sticky",
        top: 0,
        zIndex: 100,
        background: "rgba(255,255,255,0.92)",
        backdropFilter: "blur(6px)",
        WebkitBackdropFilter: "blur(6px)",
        borderBottom: "1px solid #e0e0e0",
      }}
    >
      <div
        style={{
          position: "relative",
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
        <Logo onClick={goHome} />
        {/* 헤더 전체 기준 정중앙에 고정 (좌우 콘텐츠 폭과 무관하게) */}
        <div
          style={{
            position: "absolute",
            left: "50%",
            top: "50%",
            transform: "translate(-50%, -50%)",
            display: "flex",
            alignItems: "center",
            gap: 14,
          }}
        >
          <button onClick={onProjects} style={navLinkStyle}>
            내 프로젝트
          </button>
          {onSaveImage && (
            <button data-guide="save-image" onClick={onSaveImage} style={navLinkStyle}>
              이미지로 저장
            </button>
          )}
        </div>
        {right}
      </div>
    </header>
  );
}

export default function FacilitationBoard() {
  const [projects, setProjects] = useState(null);
  const [selectedProject, setSelectedProject] = useState(null);
  const [newProjectTitle, setNewProjectTitle] = useState("");
  const [newProjectGoal, setNewProjectGoal] = useState(""); // 프로젝트 목표 한 줄(선택 입력)
  const [name, setName] = useState(null);
  const [nameInput, setNameInput] = useState("");
  const [board, setBoard] = useState(emptyBoard());
  const [loaded, setLoaded] = useState(false);
  const [justCreatedId, setJustCreatedId] = useState(null);
  const [mergeMode, setMergeMode] = useState(false);
  const [selected, setSelected] = useState([]);
  const [confirmState, setConfirmState] = useState(null); // { title, message, confirmLabel, onConfirm }
  const [docType, setDocType] = useState("process"); // "문서" 탭에서 선택한 문서 종류: 과정 | 결과(TOP 5)
  const [parkingOpen, setParkingOpen] = useState(false); // 보류함 접이식 섹션 열림 여부 (기본 닫힘)
  const boardRef = useRef(board);
  boardRef.current = board;
  // 드래그 중이거나 포스트잇을 편집 중일 때는 2초 폴링이 로컬 변경을 덮어쓰지 않도록 잠시 멈춘다
  const suspendPollRef = useRef(false);
  // 보류함 항목 클릭 시 원래 의견 보드로 스크롤 이동하기 위한 topic별 DOM 참조
  const topicRefs = useRef({});
  // "이미지로 저장": 현재 탭에 실제로 렌더링된 화면 전체를 그대로 캡처하기 위한 DOM 참조
  const phaseContentRef = useRef(null);
  // 문서 탭 전용 "이미지로 저장": 다운로드 버튼 등 UI를 빼고 문서 내용(표)만 캡처하기 위한 DOM 참조
  const docContentRef = useRef(null);

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
    const project = { id: uid(), title, goal: newProjectGoal.trim(), createdAt: Date.now() };
    const nextList = [project, ...(projects || [])];
    await storage.set(PROJECTS_INDEX_KEY, JSON.stringify(nextList), true);
    await storage.set(boardKeyOf(project.id), JSON.stringify(emptyBoard()), true);
    setProjects(nextList);
    setNewProjectTitle("");
    setNewProjectGoal("");
    setSelectedProject(project);
  };

  // 프로젝트 목표 한 줄 수정. 프로젝트 메타데이터(PROJECTS_INDEX_KEY)에 저장되므로
  // 목록과 현재 selectedProject 스냅샷을 함께 갱신해야 화면에 바로 반영된다.
  const updateProjectGoal = async (goalText) => {
    if (!selectedProject) return;
    const goal = goalText.trim();
    const nextList = (projects || []).map((p) => (p.id === selectedProject.id ? { ...p, goal } : p));
    await storage.set(PROJECTS_INDEX_KEY, JSON.stringify(nextList), true);
    setProjects(nextList);
    setSelectedProject((prev) => (prev ? { ...prev, goal } : prev));
  };

  // 프로젝트 고정. 고정된 프로젝트는 목록 정렬 시 항상 위로 온다 (updateProjectGoal과 동일한 패턴으로 인덱스만 갱신)
  const togglePinProject = async (id) => {
    const nextList = (projects || []).map((p) => (p.id === id ? { ...p, pinned: !p.pinned } : p));
    await storage.set(PROJECTS_INDEX_KEY, JSON.stringify(nextList), true);
    setProjects(nextList);
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
    const note = { id: uid(), text: "", authors: [name], topicId, isProblem: false, isParked: false };
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

  // 포스트잇 설명을 타이핑하는 동안은 로컬 상태만 갱신
  const editNoteDescriptionLocal = (id, description) => {
    setBoard((prev) => ({
      ...prev,
      notes: prev.notes.map((n) => (n.id === id ? { ...n, description } : n)),
    }));
  };

  // 설명 편집을 마칠 때 저장
  const commitNoteDescription = async (id) => {
    const myDescription = boardRef.current.notes.find((n) => n.id === id)?.description ?? "";
    await loadBoard();
    const current = boardRef.current;
    await saveBoard({
      ...current,
      notes: current.notes.map((n) => (n.id === id ? { ...n, description: myDescription } : n)),
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
      isParked: false,
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
  // 문제와 보류는 동시에 될 수 없으므로, 문제로 표시하면 보류 상태는 자동으로 해제한다.
  const toggleProblem = async (noteId) => {
    await loadBoard();
    const current = boardRef.current;
    const target = current.notes.find((n) => n.id === noteId);
    const willBeProblem = !target?.isProblem;
    const votes = { ...current.votes };
    if (!willBeProblem) delete votes[noteId];
    await saveBoard({
      ...current,
      notes: current.notes.map((n) =>
        n.id === noteId ? { ...n, isProblem: willBeProblem, isParked: willBeProblem ? false : n.isParked } : n
      ),
      votes,
    });
  };

  // 보류함 토글. isProblem과 동일한 패턴(플래그 하나, 복제 없음)을 따르되,
  // 원래 의견 보드 자리에는 그대로 남고 보류함 목록에도 함께 나타난다(표시만 두 곳).
  // 문제 상태와는 동시에 될 수 없으므로, 보류로 표시하면 문제 상태와 표는 함께 정리한다.
  const toggleParked = async (noteId) => {
    await loadBoard();
    const current = boardRef.current;
    const target = current.notes.find((n) => n.id === noteId);
    const willBeParked = !target?.isParked;
    const votes = { ...current.votes };
    if (willBeParked) delete votes[noteId];
    await saveBoard({
      ...current,
      notes: current.notes.map((n) =>
        n.id === noteId ? { ...n, isParked: willBeParked, isProblem: willBeParked ? false : n.isProblem } : n
      ),
      votes,
    });
  };

  // 보류함 항목 클릭 시 원래 속한 의견 보드로 스크롤 이동
  const scrollToTopic = (topicId) => {
    topicRefs.current[topicId]?.scrollIntoView({ behavior: "smooth", block: "center" });
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

  // "이미지로 저장": 현재 보고 있는 탭에 실제로 렌더링된 화면 전체(스크롤 영역 포함)를 그대로 캡처한다
  const downloadPhaseImage = async () => {
    const node = phaseContentRef.current;
    if (!node) return;
    const dataUrl = await toPng(node, { backgroundColor: "#ffffff", pixelRatio: 2 });
    const link = document.createElement("a");
    link.download = `${selectedProject.title}-${PHASE_LABELS[board.phase] || "화면"}.png`;
    link.href = dataUrl;
    link.click();
  };

  // 문서 탭 전용 "이미지로 저장": 토글/다운로드 버튼은 빼고 문서 내용(표)만 캡처한다
  const downloadDocImage = async () => {
    const node = docContentRef.current;
    if (!node) return;
    const dataUrl = await toPng(node, { backgroundColor: "#ffffff", pixelRatio: 2 });
    const link = document.createElement("a");
    link.download = `${selectedProject.title}-${docType === "result" ? "결과" : "과정"}문서.png`;
    link.href = dataUrl;
    link.click();
  };

  // 4번(문서): 표 중심 문서를 HTML 파일로 내려받기. docType으로 "과정" 문서와 "결과"(TOP 5) 문서를 구분한다.
  const downloadDoc = (type) => {
    const html = buildDocHtml(selectedProject, board, type);
    const blob = new Blob([html], { type: "text/html;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.download = `${selectedProject.title}-${type === "result" ? "결과" : "과정"}문서.html`;
    link.href = url;
    link.click();
    URL.revokeObjectURL(url);
  };

  // 4번(문서): 표 중심 문서를 마크다운 파일로 내려받기 (노션·구글독스 등에 붙여넣기 좋음)
  const downloadDocMarkdown = (type) => {
    const md = buildDocMarkdown(selectedProject, board, type);
    const blob = new Blob([md], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.download = `${selectedProject.title}-${type === "result" ? "결과" : "과정"}문서.md`;
    link.href = url;
    link.click();
    URL.revokeObjectURL(url);
  };

  // ---- 화면 1: 프로젝트 목록 / 생성 ----
  if (!selectedProject) {
    return (
      <div>
        <TopBar onProjects={backToProjects} />
        <div style={{ maxWidth: 520, margin: "0 auto", padding: 24, fontFamily: "sans-serif" }}>
          <div style={{ fontSize: 20, fontWeight: 600, marginBottom: 4 }}>퍼실리테이션 보드</div>
          <div style={{ fontSize: 13, color: "#888", marginBottom: 24 }}>
            프로젝트별로 진행 내용이 저장됩니다. 이전 프로젝트는 언제든 다시 열어볼 수 있어요.
          </div>
          <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
            <input
              value={newProjectTitle}
              onChange={(e) => setNewProjectTitle(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && createProject()}
              placeholder="새 프로젝트 이름 (예: 2026년 3분기 회고)"
              style={{ flex: 1, padding: "8px 12px", borderRadius: 8, border: "1px solid #ddd", fontSize: 14 }}
            />
            <button
              onClick={createProject}
              style={{ padding: "8px 16px", borderRadius: 8, border: "none", background: "#242424", color: "white", cursor: "pointer", whiteSpace: "nowrap" }}
            >
              + 새 프로젝트
            </button>
          </div>
          {/* 2번: 프로젝트 목표 한 줄(선택). 시작 시점에 합의를 남겨두기 위한 필드로, 비워도 생성 가능하다. */}
          <div style={{ fontSize: 12, color: "#999", marginBottom: 4 }}>이번 프로젝트에서 결정하려는 것 (선택)</div>
          <input
            value={newProjectGoal}
            onChange={(e) => setNewProjectGoal(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && createProject()}
            placeholder="예: 신규 유입 사용자를 늘릴 방법 3가지 찾기"
            style={{ width: "100%", padding: "8px 12px", borderRadius: 8, border: "1px solid #ddd", fontSize: 14, marginBottom: 24, boxSizing: "border-box" }}
          />
          {projects === null && <div style={{ color: "#aaa", fontSize: 13 }}>불러오는 중...</div>}
          {projects && projects.length === 0 && (
            <div style={{ color: "#aaa", fontSize: 13 }}>아직 생성된 프로젝트가 없습니다.</div>
          )}
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <AnimatePresence mode="popLayout">
            {projects &&
              [...projects]
                .sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0))
                .map((p) => (
                <motion.div
                  key={p.id}
                  layout
                  initial={{ opacity: 0, y: -6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.96 }}
                  transition={{ duration: 0.2, ease: EASE }}
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
                    <div style={{ fontSize: 14, fontWeight: 500 }}>
                      {p.pinned && <span title="고정됨">📌 </span>}
                      {p.title}
                    </div>
                    <div style={{ fontSize: 12, color: "#999" }}>
                      {new Date(p.createdAt).toLocaleDateString("ko-KR")} 생성
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        togglePinProject(p.id);
                      }}
                      style={{ border: "none", background: p.pinned ? "rgba(0,0,0,0.12)" : "rgba(0,0,0,0.06)", borderRadius: 4, fontSize: 11, padding: "4px 8px", cursor: "pointer" }}
                    >
                      {p.pinned ? "고정 해제" : "고정"}
                    </button>
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
                </motion.div>
              ))}
            </AnimatePresence>
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
        <TopBar onProjects={backToProjects} />
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
            style={{ width: "100%", padding: "10px 14px", fontSize: 15, borderRadius: 8, border: "none", background: "#242424", color: "white", cursor: "pointer" }}
          >
            참여하기
          </button>
        </div>
      </div>
    );
  }

  const votesLeft = board.votesPerUser - myVoteCount(board);
  const problemNotesAll = board.notes.filter((n) => n.isProblem);
  const parkedNotesAll = board.notes.filter((n) => n.isParked); // 보류함: 모든 의견 보드를 통틀어 보류된 항목
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
      <motion.div
        key={note.id}
        {...popIn}
        onClick={() => mergeMode && toggleSelect(note.id, note.topicId)}
        style={{
          // 화면이 최대(900px 컨테이너 기준)일 때 한 줄에 정확히 4개가 놓이도록 너비를 비율로 계산
          flex: "0 0 calc(25% - 9px)",
          width: "calc(25% - 9px)",
          minWidth: 150,
          maxWidth: "100%",
          background: noteColor.bg,
          color: noteColor.text,
          borderRadius: 6,
          boxShadow: isSel ? "0 0 0 2px #333" : "none",
          border: note.isProblem ? "2px solid #d4537e" : note.isParked ? "2px dashed #707070" : "1px solid rgba(0,0,0,0.06)",
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
            {note.isParked && <span title="보류됨">⏸</span>}
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
            <div style={{ display: "flex", gap: 6 }}>
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
              {/* 1번: 보류함. 문제로와 동일한 단일 플래그 패턴, 서로 동시에 될 수 없어 자동 배타 처리됨 */}
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  toggleParked(note.id);
                }}
                title={note.isParked ? "보류 해제" : "나중에 다시 논의 (보류)"}
                style={{
                  border: "none",
                  background: note.isParked ? "#707070" : "rgba(0,0,0,0.12)",
                  color: note.isParked ? "#fff" : noteColor.text,
                  borderRadius: 4,
                  fontSize: 10,
                  padding: "3px 8px",
                  cursor: "pointer",
                  fontWeight: 600,
                }}
              >
                {note.isParked ? "보류 해제" : "보류"}
              </button>
            </div>
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
                  background: iVoted ? "#242424" : "rgba(0,0,0,0.12)",
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
      </motion.div>
    );
  };

  // ---- 화면 3: 보드 본체 ----
  return (
    <div>
      <TopBar
        onProjects={backToProjects}
        onSaveImage={downloadPhaseImage}
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
              { key: "problem", label: "문제 정리 및 부가 설명" },
              { key: "voting", label: "우선순위별 결과" },
            ].map((tab) => (
              <button
                key={tab.key}
                onClick={() => setPhase(tab.key)}
                style={{
                  padding: "6px 14px",
                  borderRadius: 999,
                  border: "1px solid #ddd",
                  background: board.phase === tab.key ? "#242424" : "white",
                  color: board.phase === tab.key ? "white" : "#333",
                  fontSize: 13,
                  cursor: "pointer",
                }}
              >
                {tab.label}
              </button>
            ))}
            <button
              onClick={() => setPhase("document")}
              style={{
                padding: "6px 14px",
                borderRadius: 999,
                border: "1px solid #ddd",
                background: board.phase === "document" ? "#242424" : "white",
                color: board.phase === "document" ? "white" : "#333",
                fontSize: 13,
                cursor: "pointer",
              }}
            >
              문서
            </button>
          </div>
        </div>

        <div ref={phaseContentRef} style={{ position: "relative", background: "#fff" }}>
        <AnimatePresence initial={false}>
        {board.phase === "opinion" && (
          <motion.div key="opinion" {...fadeSlide}>
            {/* 안내 문구 배너: 글자 수에 맞춰 세로 길이가 자동으로 늘어나 잘리거나 스크롤이 생기지 않는다 */}
            <div style={{ background: "#242424", color: "#f2f2f2", borderRadius: 10, padding: "16px 18px", marginBottom: 14 }}>
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
                  color: "#f2f2f2",
                  fontSize: 13,
                  lineHeight: 1.6,
                  fontFamily: "sans-serif",
                  boxSizing: "border-box",
                }}
              />
            </div>

            {/* 2번: 프로젝트 목표 한 줄 고정. goal이 없으면 영역 자체를 표시하지 않는다.
                인라인 편집은 주제 이름 수정(renameTopic)과 같은 패턴: onBlur에 값을 반영, 비우면 이전 값 유지 */}
            {selectedProject.goal && (
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 14, fontSize: 13, color: "#333" }}>
                <span style={{ flexShrink: 0 }}>🎯 목표:</span>
                <input
                  key={selectedProject.goal}
                  defaultValue={selectedProject.goal}
                  onBlur={(e) => updateProjectGoal(e.target.value.trim() || selectedProject.goal)}
                  style={{ flex: 1, border: "none", background: "transparent", outline: "none", fontWeight: 600, color: "#333", minWidth: 0, fontFamily: "sans-serif", fontSize: 13 }}
                />
              </div>
            )}

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
                background: "#eeeeee",
                border: "1px solid #e0e0e0",
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
                  background: mergeMode ? "#242424" : "white",
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
                      style={{ marginLeft: 10, padding: "4px 12px", borderRadius: 6, border: "none", background: "#242424", color: "white", cursor: "pointer", fontSize: 12 }}
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
                const plainNotes = topicNotes.filter((n) => !n.isProblem && !n.isParked);
                // 보류된 포스트잇은 문제 섹션과 동일한 패턴으로, 일반 포스트잇 아래에 별도 구획으로 묶어 보여준다
                const parkedNotes = topicNotes.filter((n) => !n.isProblem && n.isParked);
                const canDelete = board.topics.length > 1;
                return (
                  <div
                    key={topic.id}
                    ref={(el) => {
                      topicRefs.current[topic.id] = el;
                    }}
                    style={{ width: "100%" }}
                  >
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
                            title={problemNotes.length + plainNotes.length + parkedNotes.length === 0 ? "빈 보드 삭제" : "보드 삭제"}
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
                        border: "1px solid #e0e0e0",
                        borderRadius: 10,
                        padding: 14,
                        overflowX: "hidden",
                      }}
                    >
                      {/* 6번: 문제로 표시된 포스트잇을 보드 상단에 고정 */}
                      {problemNotes.length > 0 && (
                        <div>
                          <div style={{ fontSize: 11, fontWeight: 700, color: "#c0392b", marginBottom: 8 }}>📌 문제로 표시된 의견</div>
                          <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
                            <AnimatePresence mode="popLayout">{problemNotes.map(renderNoteCard)}</AnimatePresence>
                          </div>
                        </div>
                      )}
                      {/* 5번: 일반 포스트잇은 flex-wrap으로 좌->우 채우고 줄바꿈 (가로 스크롤 없음) */}
                      {plainNotes.length > 0 && (
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
                          <AnimatePresence mode="popLayout">{plainNotes.map(renderNoteCard)}</AnimatePresence>
                        </div>
                      )}
                      {/* 1번: 보류된 포스트잇은 문제 섹션과 동일하게, 일반 포스트잇 아래에 별도 구획으로 고정 */}
                      {parkedNotes.length > 0 && (
                        <div>
                          <div style={{ fontSize: 11, fontWeight: 700, color: "#888888", marginBottom: 8 }}>⏸ 보류된 의견</div>
                          <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
                            <AnimatePresence mode="popLayout">{parkedNotes.map(renderNoteCard)}</AnimatePresence>
                          </div>
                        </div>
                      )}
                      {topicNotes.length === 0 && (
                        <div style={{ color: "#bbb", fontSize: 13, padding: 6 }}>아직 포스트잇이 없습니다.</div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            {/* 1번: 보류함. 원래 보드 자리에는 그대로 남기고(위 parkedNotes 구획에 포함), 전체 프로젝트 기준으로 모아 보여주는 접이식 섹션 */}
            <div style={{ marginTop: 20 }}>
              <button
                onClick={() => setParkingOpen((v) => !v)}
                style={{
                  width: "100%",
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  padding: "10px 14px",
                  borderRadius: parkingOpen ? "10px 10px 0 0" : 10,
                  border: "1px solid #e0e0e0",
                  background: "#eeeeee",
                  color: "#555555",
                  fontSize: 13,
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                <span>⏸ 보류함 ({parkedNotesAll.length})</span>
                <span>{parkingOpen ? "▲" : "▼"}</span>
              </button>
              <AnimatePresence>
              {parkingOpen && (
                <motion.div
                  key="parking-content"
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: "auto" }}
                  exit={{ opacity: 0, height: 0 }}
                  transition={{ duration: 0.22, ease: EASE }}
                  style={{
                    border: "1px solid #e0e0e0",
                    borderTop: "none",
                    borderRadius: "0 0 10px 10px",
                    overflow: "hidden",
                  }}
                >
                  <div style={{ padding: 12, display: "flex", flexDirection: "column", gap: 8 }}>
                  {parkedNotesAll.length === 0 && (
                    <div style={{ color: "#bbb", fontSize: 13, padding: 4 }}>보류된 의견이 없습니다.</div>
                  )}
                  <AnimatePresence mode="popLayout">
                  {parkedNotesAll.map((n) => {
                    const topicTitle = board.topics.find((t) => t.id === n.topicId)?.title || "";
                    return (
                      <motion.div
                        key={n.id}
                        {...popIn}
                        style={{
                          display: "flex",
                          flexDirection: "column",
                          gap: 6,
                          padding: "8px 10px",
                          borderRadius: 8,
                          background: "#fff",
                          border: "1px dashed #bdbdbd",
                        }}
                      >
                        <div
                          onClick={() => scrollToTopic(n.topicId)}
                          title="원래 의견 보드로 이동"
                          style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, cursor: "pointer" }}
                        >
                          <div style={{ minWidth: 0 }}>
                            <div style={{ fontSize: 11, color: "#888888", marginBottom: 2 }}>⏸ {topicTitle}</div>
                            <div style={{ fontSize: 13, color: "#444", wordBreak: "break-word" }}>
                              {n.text || <span style={{ color: "#bbb" }}>(빈 포스트잇)</span>}
                            </div>
                          </div>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              toggleParked(n.id);
                            }}
                            style={{
                              border: "none",
                              background: "rgba(0,0,0,0.08)",
                              color: "#666",
                              borderRadius: 6,
                              fontSize: 11,
                              padding: "5px 10px",
                              cursor: "pointer",
                              flexShrink: 0,
                              whiteSpace: "nowrap",
                            }}
                          >
                            의견으로 되돌리기
                          </button>
                        </div>
                        {/* 보류된 이유: "문제" 설명과 동일하게 note.description을 재사용 (문제/보류는 동시에 될 수 없어 의미가 겹치지 않음) */}
                        <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
                          <span style={{ fontSize: 11, color: "#888888", flexShrink: 0, marginTop: 6 }}>이유 :</span>
                          <textarea
                            value={n.description || ""}
                            ref={(el) => autoResizeTextarea(el)}
                            onChange={(e) => {
                              editNoteDescriptionLocal(n.id, e.target.value);
                              autoResizeTextarea(e.target);
                            }}
                            onFocus={() => {
                              suspendPollRef.current = true;
                            }}
                            onBlur={() => {
                              suspendPollRef.current = false;
                              commitNoteDescription(n.id);
                            }}
                            placeholder="보류된 이유를 입력하세요"
                            style={{ flex: 1, border: "none", background: "transparent", resize: "none", overflow: "hidden", fontSize: 13, fontFamily: "sans-serif", outline: "none", minHeight: 32 }}
                          />
                        </div>
                      </motion.div>
                    );
                  })}
                  </AnimatePresence>
                  </div>
                </motion.div>
              )}
              </AnimatePresence>
            </div>
          </motion.div>
        )}

        {board.phase === "problem" && (
          <motion.div key="problem" {...fadeSlide}>
            <div data-guide="problem-area" style={{ fontSize: 13, color: "#666", marginBottom: 16, background: "#eeeeee", border: "1px solid #e0e0e0", borderRadius: 8, padding: "10px 12px" }}>
              여러 의견 보드에서 <b>"문제로"</b> 표시된 포스트잇을 한곳에 모았습니다. 여기서 문구를 다듬으면 원래 보드의 포스트잇도 함께 바뀝니다.
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {problemNotesAll.map((n) => {
                const topicTitle = board.topics.find((t) => t.id === n.topicId)?.title || "";
                return (
                  <div key={n.id} style={{ border: "1px solid #eee", borderRadius: 8, padding: 12, display: "flex", flexDirection: "column", gap: 8, background: "#fff" }}>
                    <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
                      <span style={{ fontSize: 11, color: "#c0392b", flexShrink: 0, marginTop: 6 }} title="원래 의견 보드">
                        📌 {topicTitle}
                      </span>
                      <textarea
                        value={n.text}
                        ref={(el) => autoResizeTextarea(el)}
                        onChange={(e) => {
                          editNoteTextLocal(n.id, e.target.value);
                          autoResizeTextarea(e.target);
                        }}
                        onFocus={() => {
                          suspendPollRef.current = true;
                        }}
                        onBlur={() => {
                          suspendPollRef.current = false;
                          commitNoteText(n.id);
                        }}
                        style={{ flex: 1, border: "none", resize: "none", overflow: "hidden", fontSize: 14, fontFamily: "sans-serif", outline: "none", minHeight: 40 }}
                      />
                      <button
                        onClick={() => toggleProblem(n.id)}
                        title="문제 표시 해제 (포스트잇은 유지)"
                        style={{ border: "1px solid #eee", background: "#fff", color: "#999", borderRadius: 4, fontSize: 11, padding: "4px 8px", cursor: "pointer", flexShrink: 0 }}
                      >
                        문제 해제
                      </button>
                    </div>
                    <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
                      <span style={{ fontSize: 11, color: "#999", flexShrink: 0, marginTop: 6 }}>설명 :</span>
                      <textarea
                        value={n.description || ""}
                        ref={(el) => autoResizeTextarea(el)}
                        onChange={(e) => {
                          editNoteDescriptionLocal(n.id, e.target.value);
                          autoResizeTextarea(e.target);
                        }}
                        onFocus={() => {
                          suspendPollRef.current = true;
                        }}
                        onBlur={() => {
                          suspendPollRef.current = false;
                          commitNoteDescription(n.id);
                        }}
                        placeholder="문제에 대한 짧은 설명을 입력하세요"
                        style={{ flex: 1, border: "none", resize: "none", overflow: "hidden", fontSize: 14, fontFamily: "sans-serif", outline: "none", minHeight: 40 }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
            {problemNotesAll.length === 0 && (
              <div style={{ color: "#aaa", fontSize: 14 }}>의견 작성 탭에서 포스트잇을 "문제로" 표시하면 여기 모입니다.</div>
            )}
          </motion.div>
        )}

        {board.phase === "voting" && (
          <motion.div key="voting" {...fadeSlide}>
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
          </motion.div>
        )}

        {board.phase === "document" && (
          <motion.div key="document" {...fadeSlide}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16, flexWrap: "wrap", gap: 8 }}>
              <div style={{ display: "flex", gap: 6 }}>
                <button
                  data-guide="doc-type-process"
                  onClick={() => setDocType("process")}
                  style={{
                    padding: "6px 14px",
                    borderRadius: 999,
                    border: "1px solid #ddd",
                    background: docType === "process" ? "#242424" : "white",
                    color: docType === "process" ? "white" : "#333",
                    fontSize: 13,
                    cursor: "pointer",
                  }}
                >
                  과정 문서
                </button>
                <button
                  data-guide="doc-type-result"
                  onClick={() => setDocType("result")}
                  style={{
                    padding: "6px 14px",
                    borderRadius: 999,
                    border: "1px solid #ddd",
                    background: docType === "result" ? "#242424" : "white",
                    color: docType === "result" ? "white" : "#333",
                    fontSize: 13,
                    cursor: "pointer",
                  }}
                >
                  결과 문서(문제 우선순위 TOP 5)
                </button>
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                <button
                  onClick={() => downloadDoc(docType)}
                  style={{ padding: "8px 16px", borderRadius: 8, border: "none", background: "#242424", color: "white", cursor: "pointer", fontSize: 13 }}
                >
                  문서 다운로드 (HTML)
                </button>
                <button
                  onClick={() => downloadDocMarkdown(docType)}
                  style={{ padding: "8px 16px", borderRadius: 8, border: "1px solid #242424", background: "white", color: "#242424", cursor: "pointer", fontSize: 13 }}
                >
                  문서 다운로드 (Markdown)
                </button>
                <button
                  onClick={downloadDocImage}
                  style={{ padding: "8px 16px", borderRadius: 8, border: "1px solid #242424", background: "white", color: "#242424", cursor: "pointer", fontSize: 13 }}
                >
                  이미지로 저장
                </button>
              </div>
            </div>
            <div ref={docContentRef} style={{ background: "#fff" }}>
            <div style={{ fontSize: 13, color: "#666", marginBottom: 16 }}>
              {docType === "process" ? "의견 작성부터 문제 정리까지의 진행 과정을 표로 정리한 문서입니다." : "우선순위 TOP 5 결과만 표로 정리한 문서입니다."}
            </div>

            {docType === "process" ? (
              <>
                <DocSection title="1. 개요">
                  <DocTable>
                    <tbody>
                      <DocKV k="프로젝트명" v={selectedProject.title} />
                      <DocKV k="참여자 수" v={`${docModel.participants.length}명`} />
                      <DocKV k="작성된 의견 수" v={`${board.notes.length}개`} />
                      <DocKV k="문제로 표시된 의견 수" v={`${docModel.problemNotes.length}개`} />
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

                <DocSection title="4. 문제 정리 및 부가 설명">
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
                            <DocTd>
                              {n.text}
                              {n.description && <div style={{ color: "#888", fontSize: 12.5, marginTop: 3 }}>설명: {n.description}</div>}
                            </DocTd>
                            <DocTd>{n.authors.join(", ")}</DocTd>
                          </tr>
                        ))
                      ) : (
                        <DocEmpty span={3}>문제로 표시된 의견이 없습니다.</DocEmpty>
                      )}
                    </tbody>
                  </DocTable>
                </DocSection>
              </>
            ) : (
              <>
                <DocSection title="1. 개요">
                  <DocTable>
                    <tbody>
                      <DocKV k="프로젝트명" v={selectedProject.title} />
                      <DocKV k="문제로 표시된 의견 수" v={`${docModel.problemNotes.length}개`} />
                      <DocKV k="최다 득표" v={docModel.ranked[0] ? `${docModel.ranked[0].text} (${docModel.ranked[0].votes}표)` : "—"} />
                    </tbody>
                  </DocTable>
                </DocSection>

                <DocSection title="2. 우선순위 TOP 5 결과">
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
                      {docModel.topRanked.length ? (
                        docModel.topRanked.map((p, i) => (
                          <tr key={p.id} style={i === 0 ? { background: "#fdf3f7" } : undefined}>
                            <DocTd>{i + 1}</DocTd>
                            <DocTd>
                              {p.text}
                              {p.description && <div style={{ color: "#888", fontSize: 12.5, marginTop: 3 }}>설명: {p.description}</div>}
                            </DocTd>
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
              </>
            )}
            </div>
          </motion.div>
        )}
        </AnimatePresence>
        </div>
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
  return <th style={{ border: "1px solid #e0e0e0", padding: "9px 12px", textAlign: "left", background: "#e9e9e9", fontWeight: 700 }}>{children}</th>;
}
function DocTd({ children }) {
  return <td style={{ border: "1px solid #e0e0e0", padding: "9px 12px", textAlign: "left", verticalAlign: "top" }}>{children}</td>;
}
function DocKV({ k, v }) {
  return (
    <tr>
      <th style={{ border: "1px solid #e0e0e0", padding: "9px 12px", textAlign: "left", background: "#f2f2f2", width: 160, whiteSpace: "nowrap" }}>{k}</th>
      <DocTd>{v}</DocTd>
    </tr>
  );
}
function DocEmpty({ span, children }) {
  return (
    <tr>
      <td colSpan={span} style={{ border: "1px solid #e0e0e0", padding: "9px 12px", color: "#aaa" }}>
        {children}
      </td>
    </tr>
  );
}
