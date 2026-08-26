import { useState, useEffect, useRef, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { toPng } from "html-to-image";
import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  Table,
  TableRow,
  TableCell,
  WidthType,
  AlignmentType,
  TableOfContents,
  Footer,
  PageNumber,
} from "docx";
import { storage } from "./storage";
import { supabase } from "./supabaseClient";
import { useAuth } from "./useAuth";
import Logo from "./components/Logo";
import ConfirmDialog from "./components/ConfirmDialog";

// 화면 전환/요소 추가·삭제에 공통으로 쓰는 트랜지션 프리셋 (애플 스타일의 부드러운 완급 곡선).
// 앞으로 새 화면·리스트를 추가할 때도 이 프리셋을 그대로 재사용한다.
const EASE = [0.22, 1, 0.36, 1];
// 탭(화면) 전환용. 예전엔 나가는 화면(absolute)·들어오는 화면(relative)을 겹쳐서 자리를 맞바꾸는
// 방식을 썼는데, 둘의 실제 높이가 다르면 컨테이너 높이가 그 순간 바로 바뀌면서 튕겨 보였고,
// 그걸 framer-motion의 layout 애니메이션으로 고치려 하니 이번엔 안의 텍스트/버튼이 같이
// 눌렸다 펴지는 것처럼 부자연스럽게 늘어나 보였다(레이아웃 애니메이션은 자식 전체를 transform으로
// 스케일해서 만드는데, motion 컴포넌트가 아닌 일반 자식들은 그 스케일이 보정되지 않는다).
// 그래서 겹치기를 포기하고 나가는 화면이 다 사라진 뒤에 들어오는 화면이 뜨는 방식(AnimatePresence
// mode="wait")으로 바꿨다 — 항상 화면에 하나만 떠 있으니 컨테이너 높이가 그 하나를 그대로
// 따라가고, 스케일 보정도 필요 없다. 대신 빈 화면이 아주 잠깐 끼는데, duration을 짧게 잡아 거의
// 안 느껴지게 했다.
const fadeSlide = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0, transition: { duration: 0.2, ease: EASE } },
  exit: { opacity: 0, y: -8, transition: { duration: 0.14, ease: EASE } },
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
const PHASE_LABELS = { opinion: "의견작성", problem: "문제정리", voting: "우선순위결과", retro: "회고", document: "문서" };

// 회고 탭의 우선순위 해결여부 라벨 (문서 내보내기에서도 공용으로 사용)
const RESOLUTION_LABELS = { resolved: "해결됨", partial: "부분해결", unresolved: "미해결" };

// "프롬프트 추출"의 지시문 프리셋. 붙는 콘텐츠(문서 표준 필드·의견·문제·우선순위·회고·녹취록)는
// 프리셋과 무관하게 동일하고, 맨 앞 지시문 한 줄만 갈아끼운다 -> 프리셋 추가는 여기 한 항목만 늘리면 된다.
const PROMPT_PRESETS = [
  {
    key: "document",
    label: "정리된 문서로",
    hint: "목적·배경·추진 방향·기대 효과가 드러나는 문서",
    instruction:
      "다음은 회의에서 나온 자료입니다. 이 내용을 바탕으로 목적, 배경, 추진 방향, 기대 효과가 명확히 드러나는 정리된 문서를 작성해줘. 각 항목은 결론부터 먼저 쓰고(두괄식) 뒷받침 내용을 풀어 설명하는 대신 핵심만 짧게 나열하는 개조식으로 정리해줘.",
  },
  {
    key: "actions",
    label: "액션 아이템만",
    hint: "담당 영역별 실행 항목 리스트",
    instruction:
      "다음은 회의에서 나온 자료입니다. 이 자료에서 실행해야 할 액션 아이템만 담당 영역별로 뽑아서 리스트로 정리해줘.",
  },
  {
    key: "slack",
    label: "슬랙 공유용 요약",
    hint: "3~5줄, 캐주얼한 톤",
    instruction:
      "다음은 회의에서 나온 자료입니다. 이 자료를 슬랙 채널에 공유할 수 있도록, 3~5줄의 짧고 캐주얼한 요약으로 만들어줘.",
  },
  {
    key: "exec",
    label: "경영진 보고용",
    hint: "격식 있는 톤, 핵심만",
    instruction:
      "다음은 회의에서 나온 자료입니다. 이 자료를 경영진에게 보고할 수 있도록, 격식 있는 톤으로 핵심만 간결하게 정리해줘.",
  },
];

// 참여자 구분용 10색 파스텔. bg = 포스트잇/색상 점, tint = 참여자 배지의 옅은 배경,
// text = 포스트잇 위 본문(따뜻한 차콜 통일), border = 색상 점 테두리/보더용.
// 기존 6색(pink~teal) 사이 빈 색상환 구간(노랑·민트·코랄·모브)을 채워 10명 가까이 모여도
// 색이 겹치거나 서로 헷갈리지 않도록 했다 — 톤·채도는 기존 6색과 같은 파스텔 톤을 맞췄다.
const PALETTE = [
  { name: "pink", bg: "#f7d3de", tint: "#fdeef2", border: "#e9a8bd", text: "#242322" },
  { name: "blue", bg: "#bcd9ee", tint: "#e9f2fa", border: "#8fb9dd", text: "#242322" },
  { name: "olive", bg: "#dde3ba", tint: "#f2f4e6", border: "#b7c088", text: "#242322" },
  { name: "purple", bg: "#d6c9ee", tint: "#f0ebfa", border: "#b09fd9", text: "#242322" },
  { name: "tan", bg: "#eecd9c", tint: "#faf1e2", border: "#dcae6b", text: "#242322" },
  { name: "teal", bg: "#a9e6d3", tint: "#e6f7f1", border: "#72c9ac", text: "#242322" },
  { name: "yellow", bg: "#f3e8a6", tint: "#fbf7dc", border: "#ddc85e", text: "#242322" },
  { name: "mint", bg: "#c3e8c2", tint: "#eef8ee", border: "#8ecb90", text: "#242322" },
  { name: "coral", bg: "#f6c9b4", tint: "#fcece4", border: "#e2987d", text: "#242322" },
  { name: "mauve", bg: "#e6c9df", tint: "#f8ecf5", border: "#cd9ac0", text: "#242322" },
];

// 프로젝트 메타데이터(제목/목표/오너 등)는 실제 관계형 테이블 projects에 저장한다(owner_id 기준
// RLS를 걸려면 행 단위 테이블이 필요해서 옛 JSON 인덱스 방식에서 이관했다). 포스트잇/투표/회고 등
// 보드 본문은 지금처럼 프로젝트 id를 키로 하는 kv_store 행에 그대로 둔다.
const boardKeyOf = (projectId) => `facilitation-board:${projectId}`;
// DB 행(snake_case) <-> 앱이 쓰는 프로젝트 객체(camelCase) 변환
function fromDbProject(row) {
  return {
    id: row.id,
    title: row.title,
    goal: row.goal || "",
    pinned: !!row.pinned,
    ownerId: row.owner_id || null,
    instructions: row.instructions || DEFAULT_INSTRUCTIONS,
    votesPerUser: row.votes_per_user || 3,
    createdAt: row.created_at ? new Date(row.created_at).getTime() : Date.now(),
  };
}
// 참여자 식별에 쓸 표시 이름을 구글 프로필에서 뽑아낸다. 로그인이 곧 참여 신원이라
// (익명/수동 이름 입력 폐지), 별도 로컬 저장이나 이름 화면 없이 이 값 하나로 참여자를 구분한다.
function displayNameOf(user) {
  if (!user) return null;
  const raw = user.user_metadata?.full_name || user.user_metadata?.name || user.email || "참여자";
  // 구글 프로필 이름에 "본명(닉네임)"처럼 괄호가 들어있으면 포스트잇 작성자 배지 등에 그대로
  // 노출돼 "이름(닉네임)"이 카드마다 반복 표시되며 지저분해 보인다 — 괄호 안쪽은 잘라내고
  // 바깥쪽 이름만 쓴다(괄호만 있고 바깥이 비면 원래 이름을 그대로 둔다).
  const outsideParens = raw.replace(/\s*\([^)]*\)\s*/g, " ").trim();
  return outsideParens || raw;
}

const DEFAULT_INSTRUCTIONS =
  "퍼실리테이션: 집단이 공통의 목표를 달성하기 위해, 구성원들의 적극적인 참여와 소통을 촉진하여 효과적인 의사결정과 문제 해결을 하도록 돕는 과정입니다.\n소외되는 인원 없이 모두의 의견을 다양하게 들어볼 수 있다는 점이 장점입니다. 아래 보드에 자유롭게 작성해주세요.";

const emptyBoard = () => ({
  phase: "opinion",
  users: {},
  // 의견을 주제별로 나눠 받고 싶을 때를 위한 다중 보드 구조. 기본은 1개에서 시작하고 필요하면 늘린다
  topics: [{ id: uid(), title: "의견1" }],
  // instructions(STEP 안내 배너)·votesPerUser(1인당 투표권)는 오너 전용 편집 권한이 걸려야 해서
  // kv_store(JSON 통짜)가 아니라 projects 테이블 컬럼(instructions/votes_per_user)으로 옮겼다.
  // board 자체에는 더 이상 두지 않고, 렌더링 시 selectedProject에서 읽는다.
  // 6번: "문제"는 별도 배열이 아니라 note.isProblem 플래그로 표현한다(데이터 복제 없음).
  notes: [],
  // 7번: 투표는 note.id 기준으로 집계한다. votes[noteId] = [이름, ...]
  votes: {},
  // ===== 회고/문서 확장 필드 =====
  // 회고 KPT: 참여자 이름을 키로 갖는다(users와 동일한 키잉). retros[이름] = { keep, problem, try, done }
  // done===true인 사람의 내용만 문서에 누적되고, done 후에도 자유롭게 수정 가능(실시간 반영).
  retros: {},
  // 회고 탭 상단 "우선순위 해결여부" 섹션 표시 여부 토글 (기본 ON)
  retroPriorityCheck: true,
  // 우선순위 문제별 해결여부. priorityResolution[noteId] = "resolved" | "partial" | "unresolved"
  // (votes/isProblem과 같은 "원본은 note 하나, 여기선 표시·기록만" 패턴)
  priorityResolution: {},
  // 문서 표준 필드(프로젝트당 1개). 과정/결과 문서 양쪽에 동일하게 반영된다.
  docFields: { purpose: "", background: "", direction: "", expected: "" },
  // 회의록 녹음(헤더의 "회의록 녹음")으로 누적한 전체 회의 녹취록. 문서에 "회의 녹취록" 섹션으로 포함된다.
  // (포스트잇 녹음과 별개의 버퍼. 녹음을 멈출 때 board에 저장돼 문서/다른 참여자에게도 반영된다.)
  minutes: "",
  // 녹음 점유 상태. 마이크·음성인식은 브라우저 로컬 자원이라 두 사람이 동시에 켜면 각자 다른
  // 녹취록이 쌓여 마지막에 저장한 쪽이 상대 것을 덮어써버린다 -> "한 번에 한 명"으로 제한한다.
  // recording(boolean)만으로는 누가 켰는지 알 수 없어 recordingBy를 함께 둔다.
  recording: false,
  recordingBy: "",
  // 녹음을 "종료"로 마감했는지. 일시정지(다시 이어서 녹음할 예정)와 종료(문서 반영 후 마감)를
  // 버튼 문구로 구분해 보여주기 위한 표시용 플래그. 녹취록 내용 자체와는 무관하다.
  minutesClosed: false,
  // 문서 스냅샷(버전 고정). 이 앱의 다른 데이터는 모두 "원본 하나, 표시만 여러 곳" 원칙을 따르지만
  // 스냅샷만은 예외로 그 시점의 값을 복사해 굳혀둔다 — 원본이 바뀌어도 남아야 하는 게 존재 이유라서다.
  // snapshots[] = { id, label, at(ms), by, docType, model(buildDocModel 결과 복사본) }
  snapshots: [],
  // 하트비트 시각(ms). 녹음자가 탭을 닫으면 정지 처리가 못 돌아 recording이 true로 영구히 남는데,
  // 그러면 나머지 전원이 영영 녹음을 못 하게 된다. 녹음 중에는 주기적으로 이 값을 갱신하고,
  // 갱신이 끊긴 지 오래면(RECORDING_STALE_MS) 죽은 점유로 보고 자동으로 풀어준다.
  recordingAt: 0,
  // 탭/화면 오디오도 함께 녹음할 때 뜨는 "참여자 전원에게 알렸습니까?" 확인 모달을 이 프로젝트에서
  // 이미 한 번 확인했는지. 프로젝트당 1회만 물어보기로 해서, 한 번 true가 되면 다시 묻지 않는다.
  recordingConsentAck: false,
});

// 하트비트가 이 시간 넘게 끊기면 "녹음자가 사라졌다"고 보고 점유를 해제한다.
// 하트비트 주기(RECORDING_HEARTBEAT_MS)보다 넉넉히 크게 둬서, 일시적인 저장 실패나
// 폴링 지연 때문에 정상 녹음 중인 사람의 점유가 잘못 풀리지 않게 한다.
const RECORDING_HEARTBEAT_MS = 10000;
const RECORDING_STALE_MS = 35000;

// 문서 스냅샷(버전 고정) 보관 개수 상한. 스냅샷은 문서 전체 계산 결과를 통째로 복사해 두므로
// 무제한으로 쌓이게 두면 board(kv_store 한 행)가 계속 커진다 — 오래된 것부터 자동으로 밀어낸다.
const MAX_SNAPSHOTS = 10;

// 보드 변경 저장이 다른 참여자의 저장과 충돌했을 때 최신값으로 다시 시도하는 최대 횟수.
// 10명이 쉬지 않고 최고 속도로 연타하는 극단적 부하 테스트(사람 속도로는 사실상 안 나오는
// 조건)로 실측: MAX_TRIES=8·최대 대기 1200ms에서는 360건 중 1건(0.28%) 재시도 소진이 나왔고,
// MAX_TRIES=12·최대 대기 1500ms로 올리자 840건 연속 시도에서 실패 0건(관측된 최대 시도횟수 10,
// 여유 2회)으로 안정화됐다. 실패해도 데이터가 깨지진 않는다(그 변경 하나만 무산되고 사용자에게
// 재시도 안내가 뜬다) — 그래도 이 안내 자체를 사실상 없애기 위해 여유를 더 준다.
const MUTATE_MAX_TRIES = 12;
// 재시도 전 대기 시간. 백오프 없이 곧바로 다시 시도하면 충돌한 상대와 또 같은 순간에 부딪혀
// 계속 서로를 밀어낸다. 시도마다 대기를 늘리고 무작위 흔들림을 섞어, 경쟁하는 클라이언트들이
// 서로 다른 시점에 재시도하게 흩어준다.
const MUTATE_RETRY_BASE_MS = 80;
const MUTATE_RETRY_MAX_MS = 1500;
const mutateRetryDelay = (attempt) => {
  const grow = Math.min(MUTATE_RETRY_BASE_MS * 2 ** (attempt - 1), MUTATE_RETRY_MAX_MS);
  return Math.round(grow * (0.5 + Math.random())); // 0.5~1.5배 지터
};

// 이전 버전에서 저장된 보드를 열어도 깨지지 않도록 보정한다.
// 특히 구버전의 별도 problems 배열을 note.isProblem + votes 재키잉으로 마이그레이션한다.
function normalizeBoard(raw) {
  const b = { ...emptyBoard(), ...raw };
  if (!b.topics || b.topics.length === 0) {
    b.topics = [{ id: uid(), title: "의견1" }];
  }
  const firstTopicId = b.topics[0].id;
  b.notes = (b.notes || []).map((n) => ({ ...n, topicId: n.topicId || firstTopicId }));
  b.votes = b.votes || {};
  // 확장 필드 기본값 보정(구버전 보드 호환)
  b.retros = b.retros || {};
  b.retroPriorityCheck = b.retroPriorityCheck !== false; // 저장값 없으면 ON
  b.priorityResolution = b.priorityResolution || {};
  b.docFields = { purpose: "", background: "", direction: "", expected: "", ...(b.docFields || {}) };
  b.minutes = typeof b.minutes === "string" ? b.minutes : "";
  // 녹음 점유 필드(구버전 보드에는 recording만 있거나 아예 없다)
  b.recording = b.recording === true;
  b.recordingBy = typeof b.recordingBy === "string" ? b.recordingBy : "";
  b.recordingAt = typeof b.recordingAt === "number" ? b.recordingAt : 0;
  b.minutesClosed = b.minutesClosed === true;
  b.snapshots = Array.isArray(b.snapshots) ? b.snapshots : [];
  b.recordingConsentAck = b.recordingConsentAck === true;

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
  // "auto"는 rows 기본값(2줄)에 묶여, 한 줄짜리 내용도 2줄 높이를 유지한다.
  // 0으로 먼저 접은 뒤 scrollHeight를 재면 실제 내용 높이(짧으면 1줄, 길면 그만큼)에 정확히 맞는다.
  el.style.height = "0px";
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

// 문제로 표시된 항목의 정렬 기준을 한 곳에 모아둔다. "우선순위 결과" 탭·"문제 정리" 탭·문서 생성이
// 모두 이 두 함수만 호출하도록 통일해, 같은 데이터가 여러 곳에서 각자 다시 정렬되며 기준이 어긋나는 것을 막는다.
// 두 함수 모두 1순위는 득표수 내림차순으로 동일하고, 동점일 때의 2차 기준(빠른 시점 vs 최근 시점)만 다르다.

// 우선순위 결과 탭 / 결과 문서 TOP 목록: 득표수 내림차순, 동점이면 "문제로 표시된 시점이 빠른 순"
// (먼저 제기된 문제가 나중에 제기된 동점 문제보다 우선순위에서 앞서도록)
function sortProblemsByVotesEarliestFirst(notes, votes) {
  return [...notes].sort((a, b) => {
    const voteDiff = (votes[b.id]?.length || 0) - (votes[a.id]?.length || 0);
    if (voteDiff !== 0) return voteDiff;
    return (a.problemMarkedAt || 0) - (b.problemMarkedAt || 0);
  });
}

// 문제 정리 탭 / 과정 문서 "문제 정리" 표: 득표수 내림차순, 동점이면 "문제로 표시된 시점이 최근인 순"
// (막 새로 문제로 올라온 항목이 정리 화면 위쪽에 보이도록 — 표는 아직 안 갈렸지만 최신 이슈를 먼저 보게 함)
function sortProblemsByVotesMostRecentFirst(notes, votes) {
  return [...notes].sort((a, b) => {
    const voteDiff = (votes[b.id]?.length || 0) - (votes[a.id]?.length || 0);
    if (voteDiff !== 0) return voteDiff;
    return (b.problemMarkedAt || 0) - (a.problemMarkedAt || 0);
  });
}

// ===== 4번: 과정+결과 문서화 (표 중심) =====
// 앱 내 문서 뷰와 다운로드가 같은 데이터를 쓰도록, 표에 필요한 값을 한 곳에서 계산한다.
export function buildDocModel(project, board) {
  const participants = Object.entries(board.users).map(([name, u]) => ({ name, color: u.color }));
  const notesByTopic = board.topics.map((t) => ({
    title: t.title,
    notes: board.notes.filter((n) => n.topicId === t.id),
  }));
  const problemNotesRaw = board.notes.filter((n) => n.isProblem);
  // "문제 정리" 표 순서 = 문제 정리 탭과 동일한 기준(득표순, 동점이면 최근 표시순)
  const problemNotes = sortProblemsByVotesMostRecentFirst(problemNotesRaw, board.votes);
  // "우선순위 TOP" 순서 = 우선순위 결과 탭과 동일한 기준(득표순, 동점이면 빠른 표시순)
  const ranked = sortProblemsByVotesEarliestFirst(problemNotesRaw, board.votes).map((n) => ({
    ...n,
    votes: board.votes[n.id]?.length || 0,
    voters: board.votes[n.id] || [],
  }));
  const topRanked = ranked.slice(0, 5);
  // 문서 표준 필드(프로젝트당 1개) — 과정/결과 문서 공통
  const docFields = board.docFields || {};
  // 완료(done)한 참여자의 KPT만 문서에 누적. users 키잉을 그대로 사용해 참여자 순서 유지.
  const completedRetros = participants
    .map((p) => ({ name: p.name, color: p.color, ...(board.retros?.[p.name] || {}) }))
    .filter((r) => r.done);
  // 회고 탭 토글이 ON일 때만 우선순위 해결여부를 문서에 포함(득표순 문제 + 해결여부)
  const priorityCheckOn = board.retroPriorityCheck !== false;
  const resolutionRows = priorityCheckOn
    ? ranked.map((n) => ({ id: n.id, text: n.text, votes: n.votes, resolution: board.priorityResolution?.[n.id] || "" }))
    : [];
  // 회의록 녹음(헤더)으로 누적한 전체 녹취록 — 있을 때만 "회의 녹취록" 섹션으로 문서에 포함
  const minutes = (board.minutes || "").trim();
  return { participants, notesByTopic, problemNotes, ranked, topRanked, docFields, completedRetros, priorityCheckOn, resolutionRows, minutes };
}

function mdEsc(s) {
  return String(s ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>");
}

// 다운로드용 마크다운 문서 문자열 생성 (노션·구글독스 등에 붙여넣기 좋은 표 형식)
function buildDocMarkdown(project, board, docType = "process") {
  const { participants, notesByTopic, problemNotes, ranked, topRanked, docFields, completedRetros, priorityCheckOn, resolutionRows, minutes } = buildDocModel(project, board);
  const dateStr = new Date().toLocaleString("ko-KR");
  const topVote = ranked[0];

  // 회의 녹취록 — 회의록 녹음 내용이 있을 때만 (표가 아닌 본문이라 줄바꿈만 유지)
  const minutesSection = minutes ? `## 회의 녹취록\n\n${minutes.replace(/\r?\n/g, "  \n")}` : "";

  // 문서 표준 정보(목적/배경/추진 방향/기대 효과) — 과정/결과 공통, 항상 최상단
  const fieldsSection = `## 문서 표준 정보

| 항목 | 내용 |
| --- | --- |
${[
    ["목적", docFields.purpose],
    ["배경", docFields.background],
    ["추진 방향", docFields.direction],
    ["기대 효과", docFields.expected],
  ]
    .map(([k, v]) => `| ${mdEsc(k)} | ${v && v.trim() ? mdEsc(v) : "—"} |`)
    .join("\n")}`;

  // 우선순위 해결여부 (회고 토글 ON일 때만)
  const resolutionSection = priorityCheckOn
    ? `## 우선순위 해결여부

| # | 문제 | 득표 | 해결여부 |
| --- | --- | --- | --- |
${
        resolutionRows.length
          ? resolutionRows.map((r, i) => `| ${i + 1} | ${mdEsc(r.text)} | ${r.votes}표 | ${RESOLUTION_LABELS[r.resolution] || "미정"} |`).join("\n")
          : "| - | 우선순위로 정리된 문제가 없습니다. | - | - |"
      }`
    : "";

  // 회고(KPT) — 완료한 참여자만
  const retroSection = `## 회고 (KPT)

${
    completedRetros.length
      ? completedRetros
          .map(
            (r) =>
              `### ${r.name}\n\n| 구분 | 내용 |\n| --- | --- |\n| Keep | ${r.keep && r.keep.trim() ? mdEsc(r.keep) : "—"} |\n| Problem | ${r.problem && r.problem.trim() ? mdEsc(r.problem) : "—"} |\n| Try | ${r.try && r.try.trim() ? mdEsc(r.try) : "—"} |`
          )
          .join("\n\n")
      : "완료된 회고가 없습니다."
  }`;

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

${fieldsSection}

## 개요

| 항목 | 내용 |
| --- | --- |
${overviewRows}

## 우선순위 TOP 5 결과

| 순위 | 문제 | 득표 | 투표자 |
| --- | --- | --- | --- |
${topRows}

${resolutionSection}

${retroSection}

${minutesSection}

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

${fieldsSection}

## 개요

| 항목 | 내용 |
| --- | --- |
${overviewRows}

## 참여자

| 이름 | 배정 색상 |
| --- | --- |
${participantRows}

## 의견 모음 (과정)

| 주제 | 내용 | 작성자 |
| --- | --- | --- |
${opinionRows}

## 문제 정리 및 부가 설명

| # | 문제 | 작성자 |
| --- | --- | --- |
${problemRows}

${resolutionSection}

${retroSection}

${minutesSection}

---
Generated by Onalign
`;
}

// ===== "프롬프트 추출": 문서 내용을 외부 AI에 붙여넣을 지시문 한 덩어리로 조립 =====
// buildDocMarkdown/buildDocDocx와 같은 자리·같은 규칙(project, board, docType을 받는 순수 함수)에 둔다.
// presetKey는 맨 앞 지시문 한 줄만 갈아끼우고, include 플래그는 선택형 섹션(문서표준필드·회고·녹취록)을
// 붙이거나 뺀다. 문서 유형(과정/결과)에 따라 원래 들어가던 의견·문제·우선순위는 항상 포함한다.
export function buildDocPrompt(project, board, docType = "process", presetKey = "document", include = {}) {
  const { withMinutes = true, withRetros = true, withFields = true } = include;
  const { docFields, notesByTopic, problemNotes, topRanked, resolutionRows, priorityCheckOn, minutes, completedRetros } =
    buildDocModel(project, board);
  const v = (s) => (s && s.trim() ? s.trim() : "(입력 없음)");
  const preset = PROMPT_PRESETS.find((p) => p.key === presetKey) || PROMPT_PRESETS[0];

  const parts = [preset.instruction];

  if (withFields) {
    parts.push(
      "",
      "## 문서 표준 정보",
      `- 목적: ${v(docFields.purpose)}`,
      `- 배경: ${v(docFields.background)}`,
      `- 추진 방향: ${v(docFields.direction)}`,
      `- 기대 효과: ${v(docFields.expected)}`
    );
  }

  if (docType === "result") {
    parts.push("", "## 우선순위 결과");
    if (topRanked.length) {
      topRanked.forEach((p, i) => {
        parts.push(`${i + 1}. ${p.text}${p.description ? ` (설명: ${p.description})` : ""} — ${p.votes}표`);
      });
    } else {
      parts.push("(우선순위로 정리된 문제 없음)");
    }
    if (priorityCheckOn && resolutionRows.length) {
      parts.push("", "## 해결여부");
      resolutionRows.forEach((r) => {
        parts.push(`- ${r.text}: ${RESOLUTION_LABELS[r.resolution] || "미정"}`);
      });
    }
  } else {
    parts.push("", "## 의견 모음");
    if (board.notes.length) {
      notesByTopic.forEach((t) => {
        t.notes.forEach((n) => {
          parts.push(`- [${t.title}] ${n.text || "(빈 포스트잇)"}${n.isProblem ? " (문제로 표시됨)" : ""}`);
        });
      });
    } else {
      parts.push("(작성된 의견 없음)");
    }
    parts.push("", "## 문제 정리");
    if (problemNotes.length) {
      problemNotes.forEach((n, i) => {
        parts.push(`${i + 1}. ${n.text}${n.description ? ` — ${n.description}` : ""}`);
      });
    } else {
      parts.push("(문제로 표시된 의견 없음)");
    }
  }

  // 완료된 회고(KPT) — 이전까지 프롬프트에서 빠져 있던 섹션이라 이번에 함께 넣는다.
  if (withRetros && completedRetros.length) {
    parts.push("", "## 완료된 회고 (KPT)");
    completedRetros.forEach((r) => {
      parts.push(`- ${r.name} / Keep: ${v(r.keep)} / Problem: ${v(r.problem)} / Try: ${v(r.try)}`);
    });
  }

  if (withMinutes && minutes.trim()) {
    parts.push("", "## 회의 녹취록", minutes.trim());
  }

  return parts.join("\n");
}

// ===== docx(Word) 다운로드 =====
// HTML/마크다운 다운로드와 동일하게 buildDocModel의 계산 결과를 그대로 재사용한다(원본 하나, 표현만 다름).
// 표 셀 하나에 여러 줄이 들어갈 수 있으므로(부가 설명, 회의 녹취록 등) 줄바꿈마다 별도 Paragraph로 나눠 넣는다.
function docCellParagraphs(text, { bold = false } = {}) {
  const str = text == null ? "" : String(text);
  const lines = str.trim() ? str.split(/\r?\n/) : ["—"];
  return lines.map(
    (line) =>
      new Paragraph({
        children: [new TextRun({ text: line, bold, italics: !str.trim() })],
      })
  );
}

function docCell(text, { header = false, widthPct } = {}) {
  return new TableCell({
    width: widthPct ? { size: widthPct, type: WidthType.PERCENTAGE } : undefined,
    shading: header ? { fill: "E9E9E9" } : undefined,
    children: docCellParagraphs(text, { bold: header }),
  });
}

// 라벨(굵게, 회색 배경) | 값 형태의 세로 표 (문서 표준 정보, 개요 등)
function docKvTable(pairs) {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: pairs.map(
      ([k, v]) =>
        new TableRow({
          children: [docCell(k, { header: true, widthPct: 25 }), docCell(v)],
        })
    ),
  });
}

// 헤더 행 + 데이터 행으로 이뤄진 표 (의견 모음, 우선순위 TOP 5 등)
function docDataTable(headers, rows) {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      new TableRow({ tableHeader: true, children: headers.map((h) => docCell(h, { header: true })) }),
      ...rows.map((r) => new TableRow({ children: r.map((c) => docCell(c)) })),
    ],
  });
}

function docSectionHeading(text) {
  return new Paragraph({ text, heading: HeadingLevel.HEADING_1, spacing: { before: 320, after: 120 } });
}

function docSpacer() {
  return new Paragraph({ text: "", spacing: { after: 80 } });
}

// 다운로드용 Word(.docx) 문서 생성. HTML 버전과 같은 구성(문서 표준 정보 → 개요 → 본문 → 우선순위 해결여부 → 회고 → 회의 녹취록)을
// Word의 제목 스타일(Heading)과 표 기능으로 그대로 옮긴다.
export function buildDocDocx(project, board, docType = "process") {
  const { participants, notesByTopic, problemNotes, ranked, topRanked, docFields, completedRetros, priorityCheckOn, resolutionRows, minutes } = buildDocModel(project, board);
  const dateStr = new Date().toLocaleString("ko-KR");
  const topVote = ranked[0];
  const isResult = docType === "result";

  const children = [
    new Paragraph({ text: project.title, heading: HeadingLevel.TITLE }),
    new Paragraph({
      children: [new TextRun({ text: `Onalign 퍼실리테이션 ${isResult ? "결과" : "과정"} 문서 · ${dateStr}`, color: "888888", size: 20 })],
      spacing: { after: 200 },
    }),

    // 목차. Word의 필드 기능이라 파일을 처음 열 때는 비어 있고, Word가 "필드를 업데이트할까요?"를
    // 물으면 예를 누르거나 F9를 눌러야 채워진다(클라이언트에서 페이지 수를 알 수 없어 미리 계산이 불가).
    docSectionHeading("목차"),
    new TableOfContents("목차", { hyperlink: true, headingStyleRange: "1-2" }),
    docSpacer(),

    docSectionHeading("문서 표준 정보"),
    docKvTable([
      ["목적", docFields.purpose],
      ["배경", docFields.background],
      ["추진 방향", docFields.direction],
      ["기대 효과", docFields.expected],
    ]),
    docSpacer(),

    docSectionHeading("개요"),
    docKvTable(
      isResult
        ? [
            ["프로젝트명", project.title],
            ["문서 생성일시", dateStr],
            ["문제로 표시된 의견 수", `${problemNotes.length}개`],
            ["최다 득표", topVote ? `${topVote.text} (${topVote.votes}표)` : "—"],
          ]
        : [
            ["프로젝트명", project.title],
            ["문서 생성일시", dateStr],
            ["참여자 수", `${participants.length}명`],
            ["작성된 의견 수", `${board.notes.length}개`],
            ["문제로 표시된 의견 수", `${problemNotes.length}개`],
          ]
    ),
    docSpacer(),
  ];

  if (isResult) {
    children.push(
      docSectionHeading("우선순위 TOP 5 결과"),
      docDataTable(
        ["순위", "문제", "득표", "투표자"],
        topRanked.length
          ? topRanked.map((p, i) => [String(i + 1), p.description ? `${p.text}\n설명: ${p.description}` : p.text, `${p.votes}표`, p.voters.join(", ") || "—"])
          : [["-", "결과가 없습니다.", "-", "-"]]
      ),
      docSpacer()
    );
  } else {
    children.push(
      docSectionHeading("참여자"),
      docDataTable(
        ["이름", "배정 색상"],
        participants.length ? participants.map((p) => [p.name, p.color.name]) : [["-", "참여자가 없습니다."]]
      ),
      docSpacer(),

      docSectionHeading("의견 모음 (과정)"),
      docDataTable(
        ["주제", "내용", "작성자"],
        board.notes.length
          ? notesByTopic.flatMap((t) => t.notes.map((n) => [t.title, (n.text || "(빈 포스트잇)") + (n.isProblem ? " [문제]" : ""), n.authors.join(", ")]))
          : [["-", "작성된 의견이 없습니다.", "-"]]
      ),
      docSpacer(),

      docSectionHeading("문제 정리 및 부가 설명"),
      docDataTable(
        ["#", "문제", "작성자"],
        problemNotes.length
          ? problemNotes.map((n, i) => [String(i + 1), n.description ? `${n.text}\n설명: ${n.description}` : n.text, n.authors.join(", ")])
          : [["-", "문제로 표시된 의견이 없습니다.", "-"]]
      ),
      docSpacer()
    );
  }

  if (priorityCheckOn) {
    children.push(
      docSectionHeading("우선순위 해결여부"),
      docDataTable(
        ["#", "문제", "득표", "해결여부"],
        resolutionRows.length
          ? resolutionRows.map((r, i) => [String(i + 1), r.text, `${r.votes}표`, RESOLUTION_LABELS[r.resolution] || "미정"])
          : [["-", "우선순위로 정리된 문제가 없습니다.", "-", "-"]]
      ),
      docSpacer()
    );
  }

  children.push(docSectionHeading("회고 (KPT)"));
  if (completedRetros.length) {
    completedRetros.forEach((r) => {
      children.push(
        new Paragraph({ text: r.name, heading: HeadingLevel.HEADING_2, spacing: { before: 160, after: 80 } }),
        docKvTable([
          ["Keep", r.keep],
          ["Problem", r.problem],
          ["Try", r.try],
        ]),
        docSpacer()
      );
    });
  } else {
    children.push(new Paragraph({ children: [new TextRun({ text: "완료된 회고가 없습니다.", italics: true, color: "888888" })] }), docSpacer());
  }

  if (minutes) {
    children.push(docSectionHeading("회의 녹취록"), ...docCellParagraphs(minutes), docSpacer());
  }

  children.push(
    new Paragraph({
      children: [new TextRun({ text: "Generated by Onalign", color: "aaaaaa", size: 18 })],
      alignment: AlignmentType.CENTER,
      spacing: { before: 240 },
    })
  );

  return new Document({
    styles: { default: { document: { run: { font: "맑은 고딕", size: 22 } } } },
    sections: [
      {
        // 모든 페이지 하단에 생성일자와 쪽번호를 넣는다(본문 끝의 "Generated by Onalign"은
        // 마지막 장에만 나오므로, 인쇄·회람 시 어느 페이지를 봐도 언제 만든 문서인지 알 수 있게).
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                alignment: AlignmentType.CENTER,
                children: [
                  new TextRun({ text: `${dateStr} 생성 · `, color: "999999", size: 16 }),
                  new TextRun({ children: [PageNumber.CURRENT], color: "999999", size: 16 }),
                  new TextRun({ text: " / ", color: "999999", size: 16 }),
                  new TextRun({ children: [PageNumber.TOTAL_PAGES], color: "999999", size: 16 }),
                ],
              }),
            ],
          }),
        },
        children,
      },
    ],
  });
}

// ===== 2번 관련: 작업 흐름 안내 투어 (계정당 1회, 30일 이상 재접속 시 다시 1회) =====
const GUIDE_REPEAT_MS = 30 * 24 * 60 * 60 * 1000;

// 프로젝트/이름 화면은 제외. 작업 흐름만 순서대로 연이어 안내한다.
const TOUR_STEPS = [
  { target: "add-note", screen: "opinion", text: "포스트잇을 만들고 자유롭게 적어보세요" },
  { target: "merge", screen: "opinion", text: "비슷한 의견은 합쳐보세요" },
  { target: "note-board", screen: "opinion", text: "중요한 의견은 '문제로' 표시하세요" },
  { target: "vote-status", screen: "opinion", text: "문제로 표시된 의견에 투표하세요" },
  { target: "problem-area", screen: "problem", text: "문제 문구를 여기서 다듬으세요" },
  { target: "vote-area", screen: "voting", text: "득표순 결과를 확인하세요" },
  { target: "retro-priority", screen: "retro", text: "회고 단계예요. 우선순위로 정한 문제들이 이번에 해결됐는지 여기서 함께 점검하세요 (필요 없으면 토글을 꺼도 됩니다)" },
  { target: "retro-kpt", screen: "retro", text: "각자 Keep·Problem·Try를 적고 '완료'를 누르세요. 완료한 사람의 회고가 문서에 자동으로 담기고, 완료 후에도 수정하면 문서에 바로 반영돼요" },
  { target: "doc-type-process", screen: "document", text: "과정 문서에는 표준 정보(목적·배경·추진 방향·기대 효과)와 의견·문제 정리, 완료된 회고까지 한 흐름으로 정리돼요" },
  { target: "doc-type-result", screen: "document", text: "결과 문서에는 우선순위 TOP 5와 해결여부, 완료된 회고가 간추려 담겨요" },
  { target: "doc-download", screen: "document", text: "완성된 문서를 이미지·docx·마크다운으로 저장하거나, 프롬프트로 추출해 AI에게 정리를 맡기세요" },
];

function GuideCoach({ phase, onGotoScreen, user }) {
  // 계정당 1회: profiles.last_guide_seen_at을 확인하기 전까지는(비동기) 일단 안 띄운 상태로 시작해서,
  // "떴다가 바로 사라지는" 깜빡임을 막는다. 확인 결과 30일 이상 지났거나 기록이 없으면 그때 0으로 올려 시작한다.
  const [step, setStep] = useState(-1);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    (async () => {
      const { data } = await supabase.from("profiles").select("last_guide_seen_at").eq("id", user.id).maybeSingle();
      if (cancelled) return;
      const lastSeen = data?.last_guide_seen_at ? new Date(data.last_guide_seen_at).getTime() : 0;
      if (Date.now() - lastSeen > GUIDE_REPEAT_MS) setStep(0);
    })();
    return () => {
      cancelled = true;
    };
  }, [user]);
  const [rect, setRect] = useState(null);
  // 말풍선 실측 크기(화면이 좁아 텍스트가 더 꺾이면 높이가 달라짐) - 화면 밖으로 나가지 않도록 클램프할 때 사용
  const bubbleRef = useRef(null);
  const [bubbleSize, setBubbleSize] = useState({ width: 250, height: 120 });

  const active = step >= 0 && step < TOUR_STEPS.length ? TOUR_STEPS[step] : null;

  // 현재 단계 화면과 보드 화면이 다르면 해당 탭으로 자동 전환 -> 흐름대로 연이어 안내
  useEffect(() => {
    if (active && active.screen !== phase) onGotoScreen(active.screen);
  }, [active, phase, onGotoScreen]);

  // 새 단계로 넘어가면 대상 요소가 화면 밖(스크롤 아래/위)에 있어도 항상 보이도록 화면 중앙으로 스크롤한다.
  // 이게 없으면 대상이 접힌 화면 밖에 있을 때 하이라이트/말풍선이 화면 밖에 그려져 "위치가 안 맞고 안 보이는" 문제가 생긴다.
  // (헤더에 고정된 대상처럼 이미 다 보이는 요소는 스크롤하지 않는다)
  useEffect(() => {
    if (!active || active.screen !== phase) return;
    // 화면 전환/재렌더 직후 요소가 DOM에 잡히도록 약간 지연
    const t = setTimeout(() => {
      const el = document.querySelector(`[data-guide="${active.target}"]`);
      if (!el) return;
      const r = el.getBoundingClientRect();
      // 헤더에 고정된 대상(save-image)은 위쪽에 있어도 정상이므로 헤더 높이만큼의 여백을 요구하지 않는다.
      const topClear = active.target === "save-image" ? 0 : 66;
      const fullyVisible = r.top >= topClear && r.bottom <= window.innerHeight - 12;
      if (!fullyVisible) el.scrollIntoView({ block: "center", behavior: "smooth" });
    }, 80);
    return () => clearTimeout(t);
  }, [step, active, phase]);

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
    const iv = setInterval(update, 100);
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => {
      clearInterval(iv);
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, [active, phase]);

  // 말풍선 실제 렌더 크기를 측정해둔다 (창 크기가 좁아지면 폭이 줄고 줄바꿈으로 높이가 늘어남 -> 화면 밖으로 못 나가게 이 값으로 위치를 클램프한다)
  useEffect(() => {
    const measure = () => {
      if (bubbleRef.current) {
        const r = bubbleRef.current.getBoundingClientRect();
        setBubbleSize({ width: r.width, height: r.height });
      }
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [step, rect]);

  const endTour = () => {
    if (user) {
      supabase
        .from("profiles")
        .update({ last_guide_seen_at: new Date().toISOString() })
        .eq("id", user.id)
        .then(({ error }) => {
          if (error) console.error("가이드 확인 시각 저장 실패", error);
        });
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

  // 현재 화면이 아니거나 아직 단계가 없으면 아무것도 그리지 않는다.
  // rect가 없어도(대상 요소가 화면에 없어도) 안내는 계속돼야 하므로 여기서 끝내지 않는다.
  if (!active || active.screen !== phase) return null;

  // 화면이 좁아져도 말풍선이 밖으로 나가지 않도록: 폭은 뷰포트에 맞춰 줄이고,
  // 위치는 실측 크기(bubbleSize) 기준으로 좌우/상하 여백 안쪽으로 클램프한다.
  const margin = 12;
  const viewportW = window.innerWidth;
  const viewportH = window.innerHeight;
  const bubbleWidth = Math.min(250, viewportW - margin * 2);
  const bubbleHeight = bubbleSize.height || 120;

  // 대상 요소가 없을 때(예: 온보딩 중 비어 있는 "문제 정리" 탭)는 하이라이트 없이
  // 화면 중앙에 안내만 띄워 투어 흐름이 끊기지 않게 한다.
  const hasRect = !!rect;
  let left, top, below, arrowLeft;
  if (hasRect) {
    const idealLeft = rect.left + rect.width / 2 - bubbleWidth / 2;
    left = Math.min(Math.max(idealLeft, margin), Math.max(margin, viewportW - bubbleWidth - margin));
    const spaceBelow = viewportH - rect.bottom;
    const spaceAbove = rect.top;
    below = spaceBelow >= bubbleHeight + 24 || spaceBelow >= spaceAbove;
    top = below
      ? Math.min(rect.bottom + 14, viewportH - bubbleHeight - margin)
      : Math.max(rect.top - 14 - bubbleHeight, margin);
    // 화살표는 말풍선이 가장자리에 밀려도 실제 대상 쪽을 가리키도록 상대 위치로 계산
    arrowLeft = Math.min(Math.max(rect.left + rect.width / 2 - left, 16), bubbleWidth - 16);
  } else {
    left = Math.max(margin, (viewportW - bubbleWidth) / 2);
    top = Math.max(margin, (viewportH - bubbleHeight) / 2);
    below = true;
    arrowLeft = -100; // 대상이 없으면 화살표는 숨긴다
  }
  const isLast = step === TOUR_STEPS.length - 1;

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 9998, pointerEvents: "auto", background: "rgba(20,20,20,0.32)", fontFamily: "sans-serif" }}>
      {/* 가이드가 떠있는 동안은 뒤 화면 조작을 완전히 막는 모달형 오버레이.
          "다음/건너뛰기"를 누르기 전까지 다른 작업(포스트잇 추가 등)이 가능하면 가이드가 거슬리기만 하고
          안 읽고 넘어가는 문제가 있어, 가이드를 다 보거나 건너뛰어야만 다음 작업이 가능하도록 강제한다. */}
      <style>{`@keyframes onalignPulse{0%{box-shadow:0 0 0 0 rgba(114,201,172,.55)}70%{box-shadow:0 0 0 8px rgba(114,201,172,0)}100%{box-shadow:0 0 0 0 rgba(114,201,172,0)}}`}</style>

      {hasRect && active.target !== "vote-area" && (
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
        ref={bubbleRef}
        initial={{ opacity: 0, scale: 0.92 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.2, ease: EASE }}
        style={{
          position: "absolute",
          left,
          top,
          width: bubbleWidth,
          maxWidth: `calc(100vw - ${margin * 2}px)`,
          background: "#242424",
          color: "#f2f2f2",
          borderRadius: 12,
          padding: "14px 16px",
          boxShadow: "0 10px 32px rgba(0,0,0,.3)",
          pointerEvents: "auto",
          boxSizing: "border-box",
        }}
      >
        {hasRect && (
          <div
            style={{
              position: "absolute",
              left: arrowLeft - 6,
              transform: "rotate(45deg)",
              width: 12,
              height: 12,
              background: "#242424",
              ...(below ? { top: -6 } : { bottom: -6 }),
            }}
          />
        )}
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
function TopBar({ onProjects, onCopyLink, linkCopied, onSaveImage, onMinutes, minutesRecording, user, onSignOut, dotColor, displayName, onRenameNickname, myColor, onChangeColor, right }) {
  const goHome = () => {
    window.location.href = "/";
  };
  // 이름 배지 클릭 -> 인라인 편집(비제어 input, blur/Enter 시 커밋). onRenameNickname은
  // 보드 화면(dotColor가 있을 때)에서만 넘어오므로, "내 프로젝트" 목록 등에서는 자동으로
  // 편집 불가능한 일반 배지로 남는다.
  const [editingNickname, setEditingNickname] = useState(false);
  const commitNickname = (e) => {
    setEditingNickname(false);
    const trimmed = e.target.value.trim();
    if (trimmed && trimmed !== displayName) onRenameNickname?.(trimmed);
  };
  // 색상 점 클릭 -> 팔레트 펼침. onChangeColor도 보드 화면에서만 넘어온다(닉네임과 동일한 조건).
  const [colorPickerOpen, setColorPickerOpen] = useState(false);
  return (
    <header
      style={{
        position: "sticky",
        top: 0,
        zIndex: 100,
        background: "#fff",
        borderBottom: "1px solid rgba(36,35,34,.09)",
      }}
    >
      <div
        style={{
          maxWidth: 1120,
          margin: "0 auto",
          padding: "13px 24px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 16,
          flexWrap: "wrap",
        }}
      >
        {/* 로고 + "내 프로젝트"를 왼쪽에 배치. "내 프로젝트"는 우측 버튼 줄과 같은 세로 패딩을 가져
            버튼 줄과 같은 높이·중심선에 놓이게 한다(로고 높이가 위치를 좌우하지 않도록). */}
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <Logo onClick={goHome} height={30} />
          <button
            onClick={onProjects}
            style={{ border: "none", background: "none", color: "#6f6b66", fontSize: 15, fontWeight: 600, cursor: "pointer", padding: "10.5px 2px 5.5px 2px", lineHeight: 1, whiteSpace: "nowrap" }}
          >
            내 프로젝트
          </button>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          {onCopyLink && (
            <button
              onClick={onCopyLink}
              title="팀원과 공유할 링크 복사 (링크로 들어오면 로그인 후 바로 이 프로젝트로 진입)"
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                background: linkCopied ? "#e6f7f1" : "#fff",
                border: `1px solid ${linkCopied ? "#a9e6d3" : "rgba(36,35,34,.14)"}`,
                borderRadius: 9,
                padding: "8px 13px",
                fontSize: 13,
                fontWeight: 600,
                cursor: "pointer",
                color: linkCopied ? "#1e7a4d" : "#242322",
                whiteSpace: "nowrap",
              }}
            >
              {linkCopied ? "✓ 복사됨" : "링크 복사"}
            </button>
          )}
          {onSaveImage && (
            <button
              data-guide="save-image"
              onClick={onSaveImage}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                background: "#fff",
                border: "1px solid rgba(36,35,34,.14)",
                borderRadius: 9,
                padding: "8px 13px",
                fontSize: 13,
                fontWeight: 600,
                cursor: "pointer",
                color: "#242322",
                whiteSpace: "nowrap",
              }}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" y1="15" x2="12" y2="3" />
              </svg>
              전체 화면 이미지로 저장
            </button>
          )}
          {onMinutes && (
            <button
              onClick={onMinutes}
              title="전체 회의를 녹음해 회의록으로 만듭니다"
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                background: minutesRecording ? "#fdeaea" : "#fff",
                border: `1px solid ${minutesRecording ? "#ffcaca" : "rgba(36,35,34,.14)"}`,
                borderRadius: 9,
                padding: "8px 13px",
                fontSize: 13,
                fontWeight: 600,
                cursor: "pointer",
                color: minutesRecording ? "#d32f2f" : "#242322",
                whiteSpace: "nowrap",
              }}
            >
              <span style={{ width: 9, height: 9, borderRadius: 999, background: "#ff4242", animation: minutesRecording ? "oaRecPulse 1.1s ease-in-out infinite" : "none" }} />
              {minutesRecording ? "회의록 녹음 중" : "회의록 녹음"}
            </button>
          )}
          {/* 구글 로그인 사용자 정보 + 로그아웃. 보드 화면에서는 dotColor로 참여자 색상 점도
              같은 배지 안에 합쳐서 보여준다(따로 뱃지를 두 개 두지 않는다). 로그인 안 했으면
              아무것도 표시하지 않는다(로그인 유도는 "내 프로젝트" 화면 본문의 큰 버튼이 담당). */}
          {user && (
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              {editingNickname ? (
                <input
                  autoFocus
                  defaultValue={displayName}
                  maxLength={20}
                  onBlur={commitNickname}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") e.currentTarget.blur();
                    if (e.key === "Escape") setEditingNickname(false);
                  }}
                  style={{ width: 120, background: "#fff", border: "1px solid #8fb9dd", borderRadius: 999, padding: "5px 12px", fontSize: 13, fontWeight: 600, color: "#242322", outline: "none" }}
                />
              ) : (
                <span
                  style={{ display: "inline-flex", alignItems: "center", gap: 6, background: dotColor ? "#f2f2f2" : "transparent", borderRadius: 999, padding: dotColor ? "5px 12px 5px 8px" : 0, fontSize: 13, fontWeight: 600, color: dotColor ? "#242322" : "#57534e", maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                >
                  {/* 색상 점만 따로 클릭 대상(내 포스트잇 색 바꾸기) — 이름 텍스트 클릭(닉네임 편집)과
                      영역이 겹치지 않게 분리한다. onChangeColor가 없는 화면(목록 등)에서는 그냥 점이다. */}
                  {dotColor && (
                    <span style={{ position: "relative", flexShrink: 0 }}>
                      <span
                        onClick={onChangeColor ? () => setColorPickerOpen((v) => !v) : undefined}
                        title={onChangeColor ? "클릭해서 이 회의에서 쓸 내 포스트잇 색을 바꿀 수 있어요" : undefined}
                        style={{ display: "block", width: 15, height: 15, borderRadius: 999, background: dotColor, cursor: onChangeColor ? "pointer" : "default" }}
                      />
                      {colorPickerOpen && (
                        <>
                          <div onClick={() => setColorPickerOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 199 }} />
                          <div
                            style={{
                              position: "absolute",
                              top: "calc(100% + 8px)",
                              left: 0,
                              zIndex: 200,
                              background: "#fff",
                              border: "1px solid rgba(36,35,34,.12)",
                              borderRadius: 12,
                              boxShadow: "0 10px 32px rgba(0,0,0,.16)",
                              padding: 10,
                              display: "grid",
                              gridTemplateColumns: "repeat(5, 1fr)",
                              gap: 8,
                              width: 168,
                            }}
                          >
                            {PALETTE.map((c) => (
                              <button
                                key={c.name}
                                onClick={() => {
                                  setColorPickerOpen(false);
                                  onChangeColor(c);
                                }}
                                title={c.name}
                                style={{
                                  width: 26,
                                  height: 26,
                                  borderRadius: 999,
                                  background: c.bg,
                                  border: myColor?.name === c.name ? "3px solid #242322" : `2px solid ${c.border}`,
                                  cursor: "pointer",
                                  padding: 0,
                                }}
                              />
                            ))}
                          </div>
                        </>
                      )}
                    </span>
                  )}
                  <span
                    title={onRenameNickname ? "클릭하면 이 회의에서만 쓸 이름을 바꿀 수 있어요" : user.email || ""}
                    onClick={onRenameNickname ? () => setEditingNickname(true) : undefined}
                    style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", cursor: onRenameNickname ? "pointer" : "default" }}
                  >
                    {displayName ?? displayNameOf(user)}
                  </span>
                </span>
              )}
              <button
                onClick={onSignOut}
                style={{ border: "1px solid rgba(36,35,34,.14)", background: "#fff", color: "#8a857f", borderRadius: 9, padding: "7px 12px", fontSize: 12.5, fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap" }}
              >
                로그아웃
              </button>
            </div>
          )}
          {right}
        </div>
      </div>
    </header>
  );
}

export default function FacilitationBoard() {
  // 회의 녹음 중에는 1시간 무활동 자동 로그아웃을 멈춘다(useAuth에 넘기는 ref, 아래서 micRecording과 동기화).
  const recordingActiveRef = useRef(false);
  const { user, authLoading, sessionExpired, signInWithGoogle, signOut } = useAuth(recordingActiveRef);
  // 공유 링크(?p=프로젝트id)로 들어온 경우: 로그인은 여전히 필수지만(팀원도 구글 로그인 필요),
  // 로그인만 하면 "내 프로젝트" 목록을 거치지 않고 이 프로젝트로 바로 진입시킨다.
  // setSharedProjectId로 지울 수 있어야 한다: 링크로 들어온 뒤 "내 프로젝트"를 눌러 목록으로
  // 돌아가려 할 때, 이 값이 남아있으면 아래 effect가 같은 프로젝트로 계속 되돌려보낸다.
  const [sharedProjectId, setSharedProjectId] = useState(() => new URLSearchParams(window.location.search).get("p"));
  const claimedIdsRef = useRef(new Set()); // owner_id 귀속 시도를 프로젝트별로 1회만 하도록(다른 프로젝트로 넘어가도 각자 새로 시도돼야 함)
  const [copiedLinkId, setCopiedLinkId] = useState(null); // "내 프로젝트" 목록에서 링크 복사 완료 피드백(일시적)
  const [boardLinkCopied, setBoardLinkCopied] = useState(false); // 작업 화면 헤더의 링크 복사 완료 피드백(일시적)
  const [projects, setProjects] = useState(null);
  const [selectedProject, setSelectedProject] = useState(null);
  const [newProjectTitle, setNewProjectTitle] = useState("");
  const [newProjectGoal, setNewProjectGoal] = useState(""); // 프로젝트 목표 한 줄(선택 입력)
  const [editingProjectId, setEditingProjectId] = useState(null); // "내 프로젝트" 목록에서 인라인으로 이름/목표 수정 중인 프로젝트
  const [editTitle, setEditTitle] = useState("");
  const [editGoal, setEditGoal] = useState("");
  // 참여자 이름은 기본적으로 구글 로그인 계정의 표시 이름을 그대로 쓴다(로그아웃 상태면 null).
  // nicknameOverride가 있으면(이 프로젝트에서 닉네임을 바꾼 적이 있으면) 그 값을 대신 쓴다 —
  // 계정 전체가 아니라 "이 회의에서만" 다른 이름으로 참여할 수 있게 하기 위함.
  const [nicknameOverride, setNicknameOverride] = useState(null);
  const name = nicknameOverride || displayNameOf(user);
  const [board, setBoard] = useState(emptyBoard());
  // 어느 탭(STEP)을 보고 있는지는 참여자 개인 화면 상태다 — board(공유 데이터)에 넣으면
  // 폴링으로 한 사람이 탭을 넘길 때마다 다른 참여자 화면까지 같이 넘어가버린다("각자 원하는
  // 화면 보게 해달라"는 요청으로 분리). 온보딩 가이드 투어의 자동 탭전환도 이제 내 화면에만 영향을 준다.
  const [activeTab, setActiveTab] = useState("opinion");
  const [loaded, setLoaded] = useState(false);
  const [justCreatedId, setJustCreatedId] = useState(null);
  const [mergeMode, setMergeMode] = useState(false);
  const [selected, setSelected] = useState([]);
  const [confirmState, setConfirmState] = useState(null); // { title, message, confirmLabel, onConfirm }
  const [docType, setDocType] = useState("process"); // "문서" 탭에서 선택한 문서 종류: 과정 | 결과(TOP 5)
  const [parkingOpen, setParkingOpen] = useState(false); // 보류함 접이식 섹션 열림 여부 (기본 닫힘)
  const [docxDownloading, setDocxDownloading] = useState(false); // docx 생성 중 다운로드 버튼 비활성화용
  const [pdfDownloading, setPdfDownloading] = useState(false); // PDF 생성 중(캡처+jsPDF 로딩) 버튼 비활성화용
  const [snapshotListOpen, setSnapshotListOpen] = useState(false); // 고정된 문서 목록 펼침 여부
  const [viewingSnapshotId, setViewingSnapshotId] = useState(null); // 열어본 스냅샷(있으면 현재 문서 대신 이걸 보여준다)
  const [promptCopied, setPromptCopied] = useState(false); // "프롬프트 추출" 복사 완료 피드백(일시적)
  // ===== 프롬프트 추출 옵션 =====
  // 예전엔 버튼을 누르면 곧바로 클립보드로 복사됐는데, 지시문 프리셋·포함 항목을 고를 수 있게 되면서
  // 먼저 선택 패널을 펼치고 그 안에서 복사하도록 바꿨다.
  const [promptOpen, setPromptOpen] = useState(false);
  const [promptPreset, setPromptPreset] = useState("document");
  const [promptInclude, setPromptInclude] = useState({ withMinutes: true, withRetros: true, withFields: true });
  // 미리보기에서 사용자가 직접 손본 내용. null이면 "자동 생성값을 그대로 쓴다"는 뜻이고,
  // 프리셋·체크박스·문서유형을 바꾸면 다시 null로 되돌려 새로 생성된 텍스트를 보여준다.
  const [promptDraft, setPromptDraft] = useState(null);
  // ===== 음성 녹음 → 텍스트 변환 (Web Speech API, 마이크 입력 기준) =====
  // recording 상태(board.recording)는 참여자 모두에게 보이는 공유 배지지만, 실제 음성 인식은
  // "녹음 버튼을 누른 이 브라우저"에서만 로컬로 돌아간다. 인식 결과도 이 브라우저에 로컬로 쌓인다.
  // 회의록 녹음(헤더): 마이크 음성을 Web Speech API로 실시간 텍스트화해 전체 회의 녹취록을 누적한다.
  // .txt 다운로드 + 문서 탭 "회의 녹취록" 섹션에 반영된다. (마이크가 하나라 녹음은 이 한 종류만 둔다.)
  const [micRecording, setMicRecording] = useState(false); // 이 브라우저에서 실제 인식이 돌고 있는지
  const [minutes, setMinutes] = useState(""); // 확정된 회의 녹취록(누적)
  const [minutesInterim, setMinutesInterim] = useState(""); // 인식 중인 임시 텍스트(아직 확정 전)
  const [minutesOpen, setMinutesOpen] = useState(false); // 회의록 패널 열림 여부
  const minutesRef = useRef(""); // onresult 콜백에서 최신 녹취록을 참조하기 위한 ref
  const [speechSupported, setSpeechSupported] = useState(true); // 브라우저가 Web Speech API를 지원하는지
  // 인식 언어. onend에서 자동 재시작할 때도 같은 값을 써야 하고, 그 콜백은 최초 렌더의 state를
  // 붙잡고 있으므로 ref로도 들고 있는다(다른 recognition 설정과 동일한 이유).
  const [minutesLang, setMinutesLang] = useState("ko-KR");
  const minutesLangRef = useRef("ko-KR");
  minutesLangRef.current = minutesLang;
  recordingActiveRef.current = micRecording; // useAuth의 무활동 타이머 정지 여부와 동기화
  const recognitionRef = useRef(null); // SpeechRecognition 인스턴스
  const wantRecordingRef = useRef(false); // 사용자가 "녹음 중"을 의도하는지 (자동 재시작 판단용)
  // ===== 탭/화면 오디오 캡처 확장 (마이크 단독의 대안, 실험적) =====
  // 사용자가 체크박스로 켜면 getDisplayMedia로 탭 오디오를 더 받아 마이크와 섞는다. 이 블록의
  // 모든 실패 경로는 조용히 마이크 단독(mic-only)으로 폴백한다 — 기존 동작을 절대 깨서는 안 된다.
  const [tabAudioOption, setTabAudioOption] = useState(false); // 사용자가 이번 녹음에 탭 오디오도 원하는지
  // null=아직 판정 전, "mic-only"=기존과 동일, "tab-audio-file-only"=파일엔 양쪽, 자막은 마이크만,
  // "tab-audio-full"=자막에도 양쪽 반영(가장 이상적이나 브라우저 지원이 검증 안 된 실험적 경로)
  const [recordingTier, setRecordingTier] = useState(null);
  const [recordedAudioUrl, setRecordedAudioUrl] = useState(null); // 방금 끝난 세션의 오디오 파일 다운로드 링크
  const micStreamRef = useRef(null); // 믹싱용으로 우리가 직접 잡은 마이크 스트림(SpeechRecognition 내부 마이크와 별개)
  const displayStreamRef = useRef(null); // getDisplayMedia 스트림(오디오만 실제로 쓰고, 비디오는 즉시 정지)
  const audioCtxRef = useRef(null);
  const mixedDestRef = useRef(null); // MediaStreamAudioDestinationNode(마이크+탭 오디오 합성 결과)
  const mediaRecorderRef = useRef(null);
  const recordedChunksRef = useRef([]);
  const boardRef = useRef(board);
  boardRef.current = board;
  // 드래그 중이거나 포스트잇을 편집 중일 때는 2초 폴링이 로컬 변경을 덮어쓰지 않도록 잠시 멈춘다
  const suspendPollRef = useRef(false);
  // 회의록 저장(mutateBoard) 도중에는 "서버 값 동기화" effect가 옛 board.minutes로
  // minutesRef를 덮어쓰지 않도록 막는다. stopRecognition()의 setMicRecording(false)가 저장 완료
  // 전에 리렌더를 일으켜 그 effect를 먼저 실행시키는 경합(race)이 있었다 — 이 플래그로 막는다.
  const minutesSyncSuspendRef = useRef(false);
  // 보류함 항목 클릭 시 원래 의견 보드로 스크롤 이동하기 위한 topic별 DOM 참조
  const topicRefs = useRef({});
  // "이미지로 저장": 현재 탭에 실제로 렌더링된 화면 전체를 그대로 캡처하기 위한 DOM 참조
  const phaseContentRef = useRef(null);
  // 문서 탭 전용 "이미지로 저장": 다운로드 버튼 등 UI를 빼고 문서 내용(표)만 캡처하기 위한 DOM 참조
  const docContentRef = useRef(null);

  // 폴링으로 마지막에 반영한 보드 원본(JSON 문자열). 값이 그대로면 setBoard를 건너뛰어
  // 2초마다 전체 트리가 불필요하게 리렌더/리플로우되는 버벅임을 없앤다.
  const lastBoardRawRef = useRef(null);
  // 조건부 저장(CAS)의 기준값. "내가 마지막으로 본 서버 상태"의 updated_at이다.
  const boardUpdatedAtRef = useRef(null);
  // 보드 변경을 한 줄로 세우는 큐. 같은 사람의 변경끼리 겹쳐서 서로를 덮어쓰는 것을 막는다.
  const mutationChainRef = useRef(Promise.resolve());
  // 자동 높이 textarea들을 추적한다. 인라인 ref(매 렌더마다 새 함수 → 매 렌더 리플로우) 대신
  // "마운트 때 1회 + 원격 변경 때만" 높이를 맞춰 입력/유휴 버벅임을 제거한다.
  const autoSizeEls = useRef(new Set());
  const autoSizeRef = useCallback((el) => {
    if (el) {
      autoSizeEls.current.add(el);
      autoResizeTextarea(el);
    }
  }, []);
  // 원격 변경(다른 참여자 편집)이 반영된 뒤에만 추적 중인 textarea 높이를 한 번에 다시 맞춘다.
  const refitAutoSize = useCallback(() => {
    autoSizeEls.current.forEach((el) => {
      if (el.isConnected) autoResizeTextarea(el);
      else autoSizeEls.current.delete(el);
    });
  }, []);
  // 포스트잇 textarea를 note.id별로 추적한다(새로 만든 포스트잇에 커서를 놓기 위함).
  // autoSizeRef와 같은 일(높이 맞추기 + 추적)을 하면서 id -> 엘리먼트 대응만 추가로 기억한다.
  // 인라인 화살표 ref를 쓰면 매 렌더마다 detach/attach가 일어나므로 여기서도 안정적인 콜백 하나만 쓴다.
  const noteTextareaEls = useRef(new Map());
  const noteTextareaRef = useCallback((el) => {
    if (el) {
      noteTextareaEls.current.set(el.dataset.noteId, el);
      autoSizeEls.current.add(el);
      autoResizeTextarea(el);
    }
  }, []);
  // 새 포스트잇을 만들면 곧바로 타이핑할 수 있게 커서를 놓는다.
  // 예전에는 textarea에 autoFocus를 걸어 뒀지만, justCreatedId는 저장(=setBoard로 포스트잇이
  // 이미 마운트된) 다음에 세팅돼서 마운트 시점엔 항상 false였다 — autoFocus는 마운트할 때만 동작하므로
  // 실제로는 한 번도 먹지 않았다. 그래서 "+ 포스트잇"을 누른 뒤 바로 입력하면 포커스가 아무 곳에도
  // 없어서 타이핑이 통째로 사라졌다(저장된 포스트잇이 모두 빈 내용이던 원인).
  useEffect(() => {
    if (!justCreatedId) return;
    const el = noteTextareaEls.current.get(justCreatedId);
    if (!el) return;
    if (!el.isConnected) {
      noteTextareaEls.current.delete(justCreatedId); // 지워진 포스트잇의 옛 엘리먼트는 정리
      return;
    }
    el.focus(); // onFocus 핸들러가 폴링도 함께 멈춰준다(타이핑 중 원격 값에 덮이지 않게)
  }, [justCreatedId]);

  // 프로젝트 목록 로드. RLS 자체는 전체 열람을 허용하지만(공유 링크로 팀원이 들어와야 하므로),
  // "내 프로젝트" 목록에는 로그인 여부에 따라 이 쿼리가 좁혀서 보여준다:
  // 로그인 상태면 내 owner_id인 것 + 아직 아무에게도 귀속 안 된(owner_id null) 것, 비로그인이면 owner_id null인 것만.
  // owner_id null도 같이 보여줘야 하는 이유: 로그인 필수화 이전에 만든 프로젝트는 owner_id가 비어 있는데,
  // "열면 자동 귀속"(아래 claim 이펙트)이 동작하려면 애초에 목록에 보여서 "열기"를 누를 수 있어야 한다.
  // 이걸 빼먹으면 로그인한 사용자에게는 그 프로젝트가 영영 안 보이는 것처럼 되어버린다.
  const loadProjects = useCallback(async () => {
    try {
      let query = supabase.from("projects").select("*").order("created_at", { ascending: false });
      query = user ? query.or(`owner_id.eq.${user.id},owner_id.is.null`) : query.is("owner_id", null);
      const { data, error } = await query;
      if (error) throw error;
      setProjects((data || []).map(fromDbProject));
    } catch (e) {
      setProjects([]);
    }
  }, [user]);

  // 공유 링크로 참여한 프로젝트 목록(내가 소유한 것이 아니라 "참여만 한" 것).
  // null = 아직 조회 전. project_members 테이블이 아직 없으면(schema.sql 미실행) 빈 배열로 둬서
  // 목록 화면 자체는 그대로 동작하게 한다 — 이 기능만 조용히 비활성된 것처럼 보인다.
  const [joinedProjects, setJoinedProjects] = useState(null);
  const loadJoinedProjects = useCallback(async () => {
    if (!user?.id) {
      setJoinedProjects([]);
      return;
    }
    try {
      // RLS가 본인 것만 돌려주므로 user_id 조건을 따로 걸지 않아도 된다.
      const { data: rows, error } = await supabase
        .from("project_members")
        .select("project_id, last_opened_at")
        .order("last_opened_at", { ascending: false });
      if (error) throw error;
      const ids = (rows || []).map((r) => r.project_id);
      if (ids.length === 0) {
        setJoinedProjects([]);
        return;
      }
      const { data: projs, error: projErr } = await supabase.from("projects").select("*").in("id", ids);
      if (projErr) throw projErr;
      // 최근 열어본 순서를 유지한다(projects 쿼리는 그 순서를 보장하지 않는다).
      const rank = new Map(ids.map((id, i) => [id, i]));
      setJoinedProjects((projs || []).map(fromDbProject).sort((a, b) => rank.get(a.id) - rank.get(b.id)));
    } catch (e) {
      console.error("참여 중인 프로젝트 조회 실패", e);
      setJoinedProjects([]);
    }
  }, [user?.id]);

  useEffect(() => {
    loadProjects();
    loadJoinedProjects();
  }, [loadProjects, loadJoinedProjects]);

  // 프로젝트를 열면 참여 기록을 남긴다(오너 포함 — last_opened_at이 "최근 열어본 순" 정렬에 쓰인다).
  // 이 기록이 없으면 게스트는 목록에서 그 프로젝트를 다시 찾을 수 없다.
  const recordedMembershipRef = useRef(new Set());
  useEffect(() => {
    if (!user?.id || !selectedProject) return;
    const key = `${selectedProject.id}:${user.id}`;
    if (recordedMembershipRef.current.has(key)) return;
    recordedMembershipRef.current.add(key);
    (async () => {
      const { error } = await supabase
        .from("project_members")
        .upsert(
          { project_id: selectedProject.id, user_id: user.id, last_opened_at: new Date().toISOString() },
          { onConflict: "project_id,user_id" }
        );
      if (error) {
        recordedMembershipRef.current.delete(key); // 다음 진입에서 다시 시도할 수 있게 되돌린다
        console.error("참여 기록 실패", error);
      }
    })();
  }, [user?.id, selectedProject?.id]);

  // 이 프로젝트에서 이미 닉네임을 바꾼 적이 있으면 그 값을 불러온다. 프로젝트를 바꾸면 일단
  // null로 되돌려(그 사이엔 구글 이름으로 보인다) 이전 프로젝트의 override가 새 프로젝트에
  // 잠깐이라도 새지 않게 한다.
  useEffect(() => {
    setNicknameOverride(null);
    if (!user?.id || !selectedProject) return;
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase
        .from("project_members")
        .select("display_name")
        .eq("project_id", selectedProject.id)
        .eq("user_id", user.id)
        .maybeSingle();
      if (!cancelled && !error && data?.display_name) setNicknameOverride(data.display_name);
    })();
    return () => {
      cancelled = true;
    };
  }, [user?.id, selectedProject?.id]);

  // 공유 링크(?p=id)로 들어온 경우 목록 화면을 거치지 않고 그 프로젝트를 바로 연다.
  // maybeSingle()은 행이 없어도 error 없이 data=null만 반환하므로, "아직 조회 중"과 "그런 프로젝트가
  // 없음"을 구분할 방법이 원래 없었다 — 존재하지 않는 id로 들어오면 이 상태로 영원히 멈춰서
  // 화면에는 "프로젝트를 불러오는 중입니다..."가 무한히 떠 있었다. sharedProjectNotFound로 구분한다.
  const [sharedProjectNotFound, setSharedProjectNotFound] = useState(false);
  useEffect(() => {
    if (!sharedProjectId || selectedProject) return;
    setSharedProjectNotFound(false);
    (async () => {
      const { data, error } = await supabase.from("projects").select("*").eq("id", sharedProjectId).maybeSingle();
      if (error) return; // 네트워크 등 일시적 오류 — "없음"으로 단정하지 않고 그대로 둔다(재진입 시 재시도)
      if (data) setSelectedProject(fromDbProject(data));
      else setSharedProjectNotFound(true); // error 없이 data도 없음 = 그런 id의 프로젝트가 실제로 없다
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sharedProjectId]);

  // 오너 없이(owner_id null) 만들어진 기존 프로젝트에, 로그인한 사용자가 처음 접근하면 자동으로 귀속시킨다.
  // 이미 다른 사람 소유로 확정된 프로젝트는 건드리지 않는다(.is("owner_id", null) 조건으로 서버에서도 보장).
  useEffect(() => {
    if (!user || !selectedProject || selectedProject.ownerId || claimedIdsRef.current.has(selectedProject.id)) return;
    claimedIdsRef.current.add(selectedProject.id);
    (async () => {
      const { data, error } = await supabase
        .from("projects")
        .update({ owner_id: user.id })
        .eq("id", selectedProject.id)
        .is("owner_id", null)
        .select()
        .maybeSingle();
      if (!error && data) setSelectedProject(fromDbProject(data));
    })();
  }, [user, selectedProject]);

  const createProject = async () => {
    const title = newProjectTitle.trim();
    if (!title) return;
    const id = uid();
    const row = {
      id,
      title,
      goal: newProjectGoal.trim(),
      owner_id: user ? user.id : null,
      instructions: DEFAULT_INSTRUCTIONS,
      votes_per_user: 3,
    };
    const { error } = await supabase.from("projects").insert(row);
    if (error) {
      console.error("프로젝트 생성 실패", error);
      return;
    }
    // 빈 보드 생성은 아직 아무도 접근하지 않은 키라 경합이 없어 조건 없이 쓴다.
    // 실패해도 프로젝트 진입은 막지 않는다(보드는 첫 변경 때 insert로 만들어진다).
    try {
      await storage.set(boardKeyOf(id), JSON.stringify(emptyBoard()));
    } catch (e) {
      console.error("빈 보드 생성 실패", e);
    }
    setNewProjectTitle("");
    setNewProjectGoal("");
    openProject(fromDbProject(row));
    loadProjects();
  };

  // 프로젝트 목표 한 줄 수정. 참여자 누구나 가능(오너 전용 아님) — projects 테이블의 goal 컬럼은
  // RLS가 전체 허용이라 그대로 업데이트한다.
  const updateProjectGoal = async (goalText) => {
    if (!selectedProject) return;
    const goal = goalText.trim();
    const { error } = await supabase.from("projects").update({ goal }).eq("id", selectedProject.id);
    if (error) {
      console.error("목표 수정 실패", error);
      return;
    }
    setProjects((prev) => (prev || []).map((p) => (p.id === selectedProject.id ? { ...p, goal } : p)));
    setSelectedProject((prev) => (prev ? { ...prev, goal } : prev));
  };

  // 프로젝트 고정. 고정된 프로젝트는 목록 정렬 시 항상 위로 온다
  const togglePinProject = async (id) => {
    const target = (projects || []).find((p) => p.id === id);
    if (!target) return;
    const pinned = !target.pinned;
    const { error } = await supabase.from("projects").update({ pinned }).eq("id", id);
    if (error) {
      console.error("고정 변경 실패", error);
      return;
    }
    setProjects((prev) => (prev || []).map((p) => (p.id === id ? { ...p, pinned } : p)));
  };

  // "내 프로젝트" 목록에서 이름/목표를 나중에 바꿀 방법이 없다는 피드백으로 추가한 인라인 수정.
  // updateProjectGoal(위)은 보드 화면 안에서 selectedProject 기준으로만 동작해서, 목록 화면에서
  // 아직 열지 않은 프로젝트를 대상으로도 쓸 수 있는 별도 경로가 필요했다.
  const startEditProject = (p) => {
    setEditingProjectId(p.id);
    setEditTitle(p.title);
    setEditGoal(p.goal || "");
  };

  const cancelEditProject = () => setEditingProjectId(null);

  const saveEditProject = async (id) => {
    const title = editTitle.trim();
    if (!title) return;
    const goal = editGoal.trim();
    const { error } = await supabase.from("projects").update({ title, goal }).eq("id", id);
    if (error) {
      console.error("프로젝트 정보 수정 실패", error);
      return;
    }
    setProjects((prev) => (prev || []).map((p) => (p.id === id ? { ...p, title, goal } : p)));
    setSelectedProject((prev) => (prev && prev.id === id ? { ...prev, title, goal } : prev));
    setEditingProjectId(null);
  };

  const deleteProject = async (id) => {
    const { error } = await supabase.from("projects").delete().eq("id", id);
    if (error) {
      console.error("삭제 실패", error);
      return;
    }
    await storage.delete(boardKeyOf(id)).catch(() => {}); // 보드 행이 남아도 프로젝트 삭제는 성립한다
    setProjects((prev) => (prev || []).filter((p) => p.id !== id));
  };

  // 목록 -> 프로젝트로 들어갈 때 항상 이 함수를 거친다. URL에 ?p=id를 남기는 것 자체는 예전과
  // 같지만(새로고침해도 그 프로젝트로 돌아옴), 이번에 history.pushState로 진짜 히스토리 항목을
  // 하나 쌓는다는 게 다르다 — 이게 없으면 브라우저 뒤로가기가 이 화면 전환을 전혀 모르고 건너뛰어,
  // "프로젝트 생성 → 뒤로가기"가 목록이 아니라 그 이전의 완전히 다른 페이지(랜딩 등)로 튕겼다.
  const openProject = (p) => {
    const url = new URL(window.location.href);
    url.searchParams.set("p", p.id);
    window.history.pushState({}, "", url);
    setSelectedProject(p);
  };

  const backToProjects = () => {
    // "내 프로젝트"로 돌아가는 것도 목록 진입과 마찬가지로 하나의 화면 전환이라, 여기서도
    // pushState로 히스토리에 남긴다 — 그래야 뒤로가기가 이 전환도 정확히 되짚어갈 수 있다.
    // 예전엔 게스트가 원래 프로젝트로 못 돌아갈까 봐 ?p=를 일부러 안 지웠는데, 이제는 "참여 중인
    // 프로젝트" 목록(project_members 기반)이 그 문제를 근본적으로 해결해서 더 이상 필요 없다.
    const url = new URL(window.location.href);
    url.searchParams.delete("p");
    window.history.pushState({}, "", url);
    setSelectedProject(null);
    setLoaded(false);
    setMergeMode(false);
    setSelected([]);
    setBoard(emptyBoard());
    setProjectDeleted(false);
    setSharedProjectNotFound(false);
    if (sharedProjectId) setSharedProjectId(null);
    // 방금 참여한 프로젝트가 목록에 바로 보이도록 다시 읽는다(참여 기록은 진입할 때 남는다).
    loadProjects();
    loadJoinedProjects();
  };

  // 브라우저 뒤로/앞으로 가기로 URL의 ?p=가 바뀌면(또는 사라지면) 그에 맞춰 화면을 동기화한다.
  // 이 리스너가 없으면 위 pushState들이 URL만 바꿀 뿐 화면은 그대로라 뒤로가기 자체가 안 먹힌다.
  useEffect(() => {
    const onPopState = () => {
      const pid = new URLSearchParams(window.location.search).get("p");
      if (pid) {
        (async () => {
          const { data, error } = await supabase.from("projects").select("*").eq("id", pid).maybeSingle();
          if (error) return; // 일시적 오류 — 화면은 그대로 두고 다음 시도를 기다린다
          if (data) setSelectedProject(fromDbProject(data));
          else setSharedProjectNotFound(true);
        })();
      } else {
        setSelectedProject(null);
        setLoaded(false);
        setMergeMode(false);
        setSelected([]);
        setBoard(emptyBoard());
        setProjectDeleted(false);
        setSharedProjectNotFound(false);
      }
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 저장소에서 현재 프로젝트의 보드 상태를 읽어옴
  // 서버 최신값을 읽어 화면 상태와 조건부 저장 기준값(updated_at)을 맞추고, "방금 읽은 보드"를 반환한다.
  // 반환값을 쓰는 게 핵심이다: 예전에는 각 변경 함수가 loadBoard() 뒤에 boardRef.current를 읽었는데,
  // boardRef.current는 렌더 중에 갱신되므로 그 시점엔 아직 "로드 이전" 스냅샷이었다. 즉 최신 데이터를
  // 받아와서 그대로 버리고 낡은 값을 저장해, 다른 참여자가 방금 만든 포스트잇을 통째로 지웠다.
  // 실패는 던진다 — 폴링은 조용히 무시하고(loadBoard), 변경 경로는 재시도/중단을 판단해야 하기 때문.
  const readBoardFresh = useCallback(async () => {
    if (!selectedProject) return null;
    const res = await storage.get(boardKeyOf(selectedProject.id));
    if (!res || !res.value) return null; // 확인된 부재(아직 행이 없음)
    boardUpdatedAtRef.current = res.updatedAt;
    const next = normalizeBoard(JSON.parse(res.value));
    // 값이 지난번과 동일하면(내가 방금 저장한 값 포함) 리렌더를 건너뛴다 -> 유휴 시 버벅임 제거
    if (res.value !== lastBoardRawRef.current) {
      lastBoardRawRef.current = res.value;
      setBoard(next);
      // 원격 변경이 반영됐을 때만 페인트 후 자동높이 textarea를 다시 맞춘다(입력 중에는 실행 안 됨)
      requestAnimationFrame(() => refitAutoSize());
    }
    return next;
  }, [selectedProject, refitAutoSize]);

  // 폴링·초기 로드용. 실패해도 다음 폴링에서 다시 시도하면 되므로 조용히 넘어간다.
  const loadBoard = useCallback(async () => {
    try {
      await readBoardFresh();
    } catch (e) {
      /* 네트워크 등 일시적 실패 — 다음 폴링에서 재시도 */
    }
    setLoaded(true);
  }, [readBoardFresh]);

  // selectedProject(projects 테이블 행)는 board와 달리 지금까지 폴링 대상이 아니었다.
  // title/goal/pinned는 원래도 그랬지만, 이번에 instructions·votesPerUser까지 여기로 옮기면서
  // "오너가 STEP 배너·투표권을 바꿔도 팀원 화면엔 새로고침 전까지 안 보이는" 회귀가 생겨 함께 폴링한다.
  const lastProjectRawRef = useRef(null);
  // 오너가 프로젝트를 삭제하면 이 행이 사라진다. 예전엔 error도 없이 data만 null이 되는 이 경우를
  // "변경 없음"과 똑같이 조용히 return해서, 삭제 직전 화면이 그대로 멈춰 있는 것처럼 보였다
  // (계속 입력하면 project row 없는 kv_store 고아 데이터만 새로 쌓임). error(네트워크 등 일시적 문제)는
  // "삭제됐다"로 단정하지 않고 그냥 다음 폴링을 기다린다 — data가 없는 경우만 확실한 삭제로 본다.
  const [projectDeleted, setProjectDeleted] = useState(false);
  const refreshSelectedProject = useCallback(async () => {
    if (!selectedProject) return;
    const { data, error } = await supabase.from("projects").select("*").eq("id", selectedProject.id).maybeSingle();
    if (error) return;
    if (!data) {
      setProjectDeleted(true);
      return;
    }
    const raw = JSON.stringify(data);
    if (raw === lastProjectRawRef.current) return; // 변경 없으면 리렌더 생략(유휴 버벅임 방지, board 폴링과 동일 패턴)
    lastProjectRawRef.current = raw;
    setSelectedProject(fromDbProject(data));
  }, [selectedProject?.id]);

  // 삭제 감지 후 안내를 잠깐 보여준 뒤 목록으로 자동 이동한다(버튼도 같이 둬서 바로 나갈 수도 있게).
  useEffect(() => {
    if (!projectDeleted) return;
    const t = setTimeout(() => backToProjects(), 2500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectDeleted]);

  // 저장이 끝까지 실패한 경우에만 알린다. 예전에는 storage.set이 Supabase 에러를 무시해서
  // 저장 실패가 화면상 성공처럼 보였다(무음 유실).
  const notifySaveFailed = useCallback(() => {
    setConfirmState({
      title: "저장하지 못했습니다",
      message:
        "다른 참여자의 변경과 계속 겹치거나 네트워크가 불안정해 방금 변경을 저장하지 못했습니다. 화면을 새로고침한 뒤 다시 시도해 주세요.",
      confirmLabel: "확인",
      onConfirm: () => setConfirmState(null),
    });
  }, []);

  // ===== 보드 변경의 유일한 경로 =====
  // mutator(current) -> next 형태의 함수를 받는다. current는 "그 순간 서버의 최신 보드"이고,
  // null을 돌려주면 변경 없음으로 본다.
  //
  // 동시 편집 대응 두 겹:
  //  1) 직렬 큐 — 같은 사람의 변경끼리 겹치지 않게 한 줄로 세운다(blur 저장 직후 클릭 저장 등).
  //  2) 조건부 저장(CAS) — 읽었을 때의 updated_at이 그대로일 때만 쓴다. 그사이 다른 참여자가
  //     저장했으면 충돌로 돌아오고, 최신값을 다시 읽어 mutator를 "다시 적용"한다.
  //     낡은 스냅샷을 덮어쓰지 않으므로 상대의 변경이 사라지지 않는다.
  const mutateBoard = useCallback(
    (mutator) => {
      const run = async () => {
        if (!selectedProject) return;
        for (let attempt = 1; attempt <= MUTATE_MAX_TRIES; attempt++) {
          let base;
          try {
            base = await readBoardFresh();
          } catch (e) {
            console.error("보드 읽기 실패", e);
            if (attempt === MUTATE_MAX_TRIES) return notifySaveFailed();
            // 읽기 실패 시 절대 쓰지 않는다(낡은 값으로 덮어쓰는 사고 방지)
            await new Promise((r) => setTimeout(r, mutateRetryDelay(attempt)));
            continue;
          }
          // 행이 아직 없는 신규 보드는 화면의 현재 상태를 기준으로 삼는다(이때 CAS는 insert가 된다)
          if (!base) base = boardRef.current;
          const next = mutator(base);
          if (!next) return;
          setBoard(next); // 낙관적 반영: 화면은 즉시 갱신하고 저장은 뒤따른다
          const str = JSON.stringify(next);
          let res;
          try {
            res = await storage.setIfUnchanged(boardKeyOf(selectedProject.id), str, boardUpdatedAtRef.current);
          } catch (e) {
            console.error("보드 저장 실패", e);
            if (attempt === MUTATE_MAX_TRIES) return notifySaveFailed();
            await new Promise((r) => setTimeout(r, mutateRetryDelay(attempt)));
            continue;
          }
          if (res.ok) {
            // 방금 저장한 값을 기억해, 다음 폴링이 같은 값을 읽어와도 리렌더하지 않게 한다
            lastBoardRawRef.current = str;
            boardUpdatedAtRef.current = res.updatedAt;
            return;
          }
          // 충돌 = 다른 참여자가 먼저 저장했다 -> 잠깐 흩어졌다가 최신값에 다시 적용
          if (attempt < MUTATE_MAX_TRIES) {
            await new Promise((r) => setTimeout(r, mutateRetryDelay(attempt)));
          }
        }
        notifySaveFailed();
      };
      // 앞선 변경이 끝난 뒤에 실행한다(실패해도 큐가 멈추지 않게 then의 양쪽에 같은 실행자를 건다)
      const chained = mutationChainRef.current.then(run, run);
      mutationChainRef.current = chained;
      return chained;
    },
    [selectedProject, readBoardFresh, notifySaveFailed]
  );

  useEffect(() => {
    if (!selectedProject) return;
    lastBoardRawRef.current = null; // 프로젝트가 바뀌면 이전 보드 원본 캐시를 비워 새로 로드되게 한다
    loadBoard();
    // 2초 간격 폴링으로 다른 참여자의 변경사항을 반영 (websocket 없이 유사 실시간 구현)
    // 단, 드래그나 텍스트 편집 중에는 건드리지 않는다 -> 안 그러면 끌던 포스트잇이 튀거나 타이핑 중 내용이 사라짐
    const iv = setInterval(() => {
      if (!suspendPollRef.current) {
        loadBoard();
        refreshSelectedProject();
      }
    }, 2000);
    return () => clearInterval(iv);
  }, [selectedProject, loadBoard, refreshSelectedProject]);

  // 프로젝트를 열면(목록 클릭이든 공유 링크든) 로그인된 구글 이름으로 자동 등록한다.
  // 이미 이 프로�트에 등록돼 있으면(재방문) 아무것도 안 하고 건너뛴다.
  const joinBoard = useCallback(async () => {
    if (!name || !selectedProject) return;
    // 여러 명이 링크를 동시에 열면 예전에는 마지막 한 명만 등록되고 나머지는 색상도 못 받았다.
    // 이제 각자 최신 users 위에 자기 자신만 얹으므로 전원이 남는다.
    await mutateBoard((current) => {
      if (current.users[name]) return null; // 이미 등록됨(색상 유지)
      return { ...current, users: { ...current.users, [name]: { color: pickColor(current.users) } } };
    });
  }, [name, selectedProject, mutateBoard]);

  useEffect(() => {
    joinBoard();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name, selectedProject?.id]);

  // 이 프로젝트에서만 쓸 표시 이름을 바꾼다(계정 이름 자체는 그대로, 회의마다 다른 이름 가능).
  // 이름이 board.users/notes.authors/votes/retros/recordingBy에 문자열 그대로 박혀 있어서, override
  // 값만 바꾸면 지금까지 내가 쓴 포스트잇·투표·회고가 전부 "낯선 옛 이름"의 것처럼 보이게 된다 —
  // 그래서 이름이 바뀌는 순간 보드 안의 흔적을 전부 새 이름으로 함께 옮긴다. 문서 스냅샷(snapshots[].by)은
  // "그 시점 기록을 고정한다"는 존재 이유상 의도적으로 건드리지 않는다.
  const updateNickname = async (rawNewName) => {
    if (!user?.id || !selectedProject) return;
    const newName = rawNewName.trim();
    if (!newName || newName === name) return;
    if (newName.length > 20) {
      setConfirmState({
        title: "이름이 너무 깁니다",
        message: "20자 이내로 입력해 주세요.",
        confirmLabel: "확인",
        onConfirm: () => setConfirmState(null),
      });
      return;
    }
    const oldName = name;
    let collided = false;
    await mutateBoard((current) => {
      collided = false;
      if (current.users[newName]) {
        collided = true; // 이 프로젝트에 이미 그 이름을 쓰는 참여자가 있다
        return null;
      }
      const nextUsers = { ...current.users };
      const myEntry = nextUsers[oldName];
      delete nextUsers[oldName];
      if (myEntry) nextUsers[newName] = myEntry;
      const rename = (n) => (n === oldName ? newName : n);
      const nextRetros = { ...current.retros };
      if (oldName in nextRetros) {
        nextRetros[newName] = nextRetros[oldName];
        delete nextRetros[oldName];
      }
      return {
        ...current,
        users: nextUsers,
        notes: current.notes.map((n) => ({ ...n, authors: (n.authors || []).map(rename) })),
        votes: Object.fromEntries(
          Object.entries(current.votes || {}).map(([noteId, voters]) => [noteId, [...new Set(voters.map(rename))]])
        ),
        retros: nextRetros,
        recordingBy: current.recordingBy === oldName ? newName : current.recordingBy,
      };
    });
    if (collided) {
      setConfirmState({
        title: "이미 사용 중인 이름입니다",
        message: "이 프로젝트에 같은 이름을 쓰는 참여자가 이미 있어요. 다른 이름을 골라 주세요.",
        confirmLabel: "확인",
        onConfirm: () => setConfirmState(null),
      });
      return;
    }
    // 보드 쪽 이전(rename)이 실제로 통과한 뒤에만 override를 확정한다 — 충돌로 취소됐는데 화면만
    // 새 이름으로 바뀌면, 데이터는 옛 이름 그대로인데 나만 새 이름으로 보이는 상태가 된다.
    setNicknameOverride(newName);
    const { error } = await supabase
      .from("project_members")
      .upsert({ project_id: selectedProject.id, user_id: user.id, display_name: newName }, { onConflict: "project_id,user_id" });
    if (error) console.error("닉네임 저장 실패", error);
  };

  const myColor = name && board.users[name] ? board.users[name].color : PALETTE[0];

  // 이 프로젝트에서만 쓸 포스트잇 색을 직접 고른다. 색은 이미 board.users[name].color에 프로젝트별로
  // 저장돼 있으므로(닉네임과 달리 별도 테이블이 필요 없다) 그 값만 바꾸면 된다. 다만 두 참여자가
  // 같은 색을 쓰면 포스트잇 색만 보고 "누가 썼는지" 구분이 안 되므로, 이미 다른 사람이 쓰는 색은
  // 고를 수 없게 막는다.
  const updateMyColor = async (newColor) => {
    if (!name || !selectedProject || myColor.name === newColor.name) return;
    let collided = false;
    await mutateBoard((current) => {
      collided = false;
      const takenByOther = Object.entries(current.users).some(([uname, u]) => uname !== name && u.color?.name === newColor.name);
      if (takenByOther) {
        collided = true;
        return null;
      }
      if (!current.users[name]) return null; // 아직 참여 등록 전이면 조용히 무시(곧 joinBoard가 배정)
      return { ...current, users: { ...current.users, [name]: { ...current.users[name], color: newColor } } };
    });
    if (collided) {
      setConfirmState({
        title: "이미 사용 중인 색상입니다",
        message: "이 프로젝트에서 다른 참여자가 이미 쓰고 있는 색이에요. 다른 색을 골라 주세요.",
        confirmLabel: "확인",
        onConfirm: () => setConfirmState(null),
      });
    }
  };

  // 새 포스트잇을 지정된 의견 보드(topic) 맨 아래에 추가한다. 배열의 뒤쪽에 붙이는 것만으로
  // "추가하면 하단에 생기는" 순서가 자연스럽게 보장된다 (별도 좌표 계산이 필요 없음)
  const createBlankNote = async (topicId) => {
    if (!name) return;
    // id를 먼저 정해두는 이유: 저장이 충돌해 재시도돼도 같은 포스트잇 하나만 추가되고,
    // 저장 성공 후 이 id로 커서를 놓을 수 있어야 한다.
    const note = { id: uid(), text: "", authors: [name], topicId, isProblem: false, isParked: false };
    await mutateBoard((current) => ({ ...current, notes: [...current.notes, note] }));
    setJustCreatedId(note.id);
  };

  // 새 의견 보드(주제) 추가
  const addTopic = async () => {
    // 제목 번호는 최신 상태 기준으로 매겨야 한다(동시에 추가되면 "의견2"가 둘 생기지 않게)
    await mutateBoard((current) => ({
      ...current,
      topics: [...current.topics, { id: uid(), title: `의견${current.topics.length + 1}` }],
    }));
  };

  const renameTopic = async (id, title) => {
    await mutateBoard((current) => ({
      ...current,
      topics: current.topics.map((t) => (t.id === id ? { ...t, title } : t)),
    }));
  };

  // 3번: 의견 보드 삭제. 빈 보드는 바로 삭제, 포스트잇이 있으면 확인 팝업을 거친다.
  const deleteTopic = async (topicId) => {
    await mutateBoard((current) => {
      const removedIds = current.notes.filter((n) => n.topicId === topicId).map((n) => n.id);
      const votes = { ...current.votes };
      removedIds.forEach((id) => delete votes[id]);
      return {
        ...current,
        topics: current.topics.filter((t) => t.id !== topicId),
        notes: current.notes.filter((n) => n.topicId !== topicId),
        votes,
      };
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

  // STEP 안내 배너는 오너 전용 편집 필드라 board(kv_store)가 아니라 projects 테이블에 저장한다.
  // 서버 쪽 강제는 projects 테이블의 trg_protect_owner_only_project_fields 트리거가 한다.
  const updateInstructions = async (text) => {
    if (!selectedProject || !isOwner) return;
    const { error } = await supabase.from("projects").update({ instructions: text }).eq("id", selectedProject.id);
    if (error) {
      console.error("STEP 안내 배너 수정 실패(오너만 가능)", error);
      return;
    }
    setSelectedProject((prev) => (prev ? { ...prev, instructions: text } : prev));
  };

  // ===== 회고(KPT) 핸들러 =====
  // 본인 칸 텍스트를 타이핑하는 동안은 로컬만 갱신(폴링이 지우지 않도록). 포스트잇 편집과 동일한 패턴.
  const editRetroLocal = (owner, field, value) => {
    setBoard((prev) => ({
      ...prev,
      retros: { ...prev.retros, [owner]: { ...(prev.retros?.[owner] || {}), [field]: value } },
    }));
  };
  // blur 시 최신 원격 상태 위에 내 KPT 텍스트만 반영해 저장(done 등 다른 필드는 원격값 유지).
  const commitRetro = async (owner) => {
    // 내가 입력한 값은 큐에 넣기 전에(=지금) 붙잡아 둔다. 큐가 실행될 때 읽으면 그사이 폴링이
    // board를 갈아끼워 빈 값이 저장될 수 있다.
    const mine = boardRef.current.retros?.[owner] || {};
    await mutateBoard((current) => {
      const existing = current.retros?.[owner] || {};
      return {
        ...current,
        retros: {
          ...current.retros,
          [owner]: { ...existing, keep: mine.keep || "", problem: mine.problem || "", try: mine.try || "" },
        },
      };
    });
  };
  // 개인 단위 완료 토글. 완료해도 잠그지 않으며, 완료된 사람 KPT만 문서에 누적된다.
  const toggleRetroDone = async (owner) => {
    await mutateBoard((current) => {
      const existing = current.retros?.[owner] || {};
      return { ...current, retros: { ...current.retros, [owner]: { ...existing, done: !existing.done } } };
    });
  };
  // 우선순위 문제별 해결여부 선택 (누구나 변경 가능)
  const setPriorityResolution = async (noteId, value) => {
    await mutateBoard((current) => ({
      ...current,
      priorityResolution: { ...current.priorityResolution, [noteId]: value },
    }));
  };
  // 회고 탭 상단 "우선순위 해결여부" 섹션 표시 토글 (누구나 켜고 끌 수 있음)
  const toggleRetroPriorityCheck = async () => {
    await mutateBoard((current) => ({ ...current, retroPriorityCheck: current.retroPriorityCheck === false }));
  };
  // 문서 표준 필드(목적/배경/추진 방향/기대 효과) 저장. 안내 문구 편집과 동일 패턴(blur 시 저장).
  const updateDocField = async (field, value) => {
    await mutateBoard((current) => ({ ...current, docFields: { ...(current.docFields || {}), [field]: value } }));
  };

  // ===== 문서 스냅샷(버전 고정) =====
  // 지금 문서에 보이는 내용을 그 시점 값 그대로 복사해 board.snapshots에 쌓는다.
  // 계산 결과(buildDocModel)를 통째로 저장하는 이유: 노트 id만 저장해두면 나중에 원본 포스트잇이
  // 수정·삭제됐을 때 스냅샷 내용도 따라 바뀌어버려 "고정"이 되지 않는다.
  const saveSnapshot = async () => {
    const model = buildDocModel(selectedProject, board);
    const snapshot = {
      id: uid(),
      at: Date.now(),
      by: name,
      docType,
      title: selectedProject.title,
      goal: selectedProject.goal || "",
      // JSON 왕복으로 깊은 복사 — 이후 board가 바뀌어도 이 안의 값은 영향받지 않아야 한다.
      model: JSON.parse(JSON.stringify(model)),
    };
    await mutateBoard((current) => ({
      ...current,
      // 오래된 것부터 자동 정리: 시간순 정렬 후 최근 MAX_SNAPSHOTS개만 남긴다.
      snapshots: [...(current.snapshots || []), snapshot].sort((a, b) => a.at - b.at).slice(-MAX_SNAPSHOTS),
    }));
  };

  const deleteSnapshot = async (id) => {
    await mutateBoard((current) => ({
      ...current,
      snapshots: (current.snapshots || []).filter((s) => s.id !== id),
    }));
  };

  // 회의 녹취록 직접 수정(문서 탭). 음성 인식이 잘못 옮긴 부분을 손으로 고칠 수 있게 문서 표준 필드와
  // 같은 패턴(blur 시 저장)으로 둔다. 녹음 중에는 인식 결과가 계속 덧붙어 편집과 충돌하므로 막는다.
  // 로컬 버퍼(minutesRef)도 함께 맞춰야 다음 "이어서 녹음"이 옛 텍스트에 덧붙지 않는다.
  const updateMinutes = async (value) => {
    minutesRef.current = value;
    setMinutes(value);
    await mutateBoard((current) => ({ ...current, minutes: value }));
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
    // 내가 입력한 텍스트는 큐에 넣기 전에 붙잡아 둔다(큐 실행 시점엔 board가 이미 갈렸을 수 있다).
    const myText = boardRef.current.notes.find((n) => n.id === id)?.text ?? "";
    await mutateBoard((current) => {
      // 그사이 다른 참여자가 이 포스트잇을 지웠다면 되살리지 않는다.
      if (!current.notes.some((n) => n.id === id)) return null;
      return { ...current, notes: current.notes.map((n) => (n.id === id ? { ...n, text: myText } : n)) };
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
    await mutateBoard((current) => {
      if (!current.notes.some((n) => n.id === id)) return null; // 그사이 삭제됐으면 되살리지 않는다
      return { ...current, notes: current.notes.map((n) => (n.id === id ? { ...n, description: myDescription } : n)) };
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
    const mergedId = uid(); // 재시도돼도 같은 결과 노트 하나만 생기도록 id를 미리 정한다
    await mutateBoard((current) => {
      const chosen = current.notes.filter((n) => selected.includes(n.id));
      // 선택 후 실제 병합 실행 사이에 다른 참여자가 선택된 것 중 일부를 지웠을 수 있다. chosen은 이미
      // "그 시점에 실제로 존재하는 것"만 남은 상태라 살아남은 것끼리 병합하면 되고, 2개 미만으로
      // 줄었을 때만(병합 자체가 의미 없음) 조용히 취소한다 — 전에는 chosen[0]이 undefined라 크래시했다.
      if (chosen.length < 2) return null;
      const rest = current.notes.filter((n) => !selected.includes(n.id));
      const votes = { ...current.votes };
      selected.forEach((id) => delete votes[id]); // 병합되어 사라지는 노트의 표는 정리
      const merged = {
        id: mergedId,
        text: chosen.map((n) => n.text).join(" / "),
        authors: [...new Set(chosen.flatMap((n) => n.authors))],
        topicId: chosen[0].topicId,
        isProblem: false,
        isParked: false,
      };
      return { ...current, notes: [...rest, merged], votes };
    });
    setSelected([]);
    setMergeMode(false);
  };

  const deleteNote = async (id) => {
    await mutateBoard((current) => {
      const votes = { ...current.votes };
      delete votes[id];
      return { ...current, notes: current.notes.filter((n) => n.id !== id), votes };
    });
  };

  // 6번: "문제로" 토글. 노트 자체에 isProblem을 표시(복제 없음). 해제 시 그 노트의 표는 정리.
  // 문제와 보류는 동시에 될 수 없으므로, 문제로 표시하면 보류 상태는 자동으로 해제한다.
  // problemMarkedAt: "문제로 표시된 시점" — 우선순위 결과/문제 정리 탭의 동점 2차 정렬 기준으로 쓰인다.
  // 해제할 때 비워서, 나중에 다시 문제로 표시하면 그 순간을 새 기준 시점으로 삼는다.
  const toggleProblem = async (noteId) => {
    await mutateBoard((current) => {
      const target = current.notes.find((n) => n.id === noteId);
      if (!target) return null; // 그사이 삭제됨
      const willBeProblem = !target.isProblem;
      const votes = { ...current.votes };
      if (!willBeProblem) delete votes[noteId];
      return {
        ...current,
        notes: current.notes.map((n) =>
          n.id === noteId
            ? { ...n, isProblem: willBeProblem, isParked: willBeProblem ? false : n.isParked, problemMarkedAt: willBeProblem ? Date.now() : undefined }
            : n
        ),
        votes,
      };
    });
  };

  // 보류함 토글. isProblem과 동일한 패턴(플래그 하나, 복제 없음)을 따르되,
  // 원래 의견 보드 자리에는 그대로 남고 보류함 목록에도 함께 나타난다(표시만 두 곳).
  // 문제 상태와는 동시에 될 수 없으므로, 보류로 표시하면 문제 상태와 표는 함께 정리한다.
  const toggleParked = async (noteId) => {
    await mutateBoard((current) => {
      const target = current.notes.find((n) => n.id === noteId);
      if (!target) return null; // 그사이 삭제됨
      const willBeParked = !target.isParked;
      const votes = { ...current.votes };
      if (willBeParked) delete votes[noteId];
      return {
        ...current,
        notes: current.notes.map((n) =>
          n.id === noteId ? { ...n, isParked: willBeParked, isProblem: willBeParked ? false : n.isProblem } : n
        ),
        votes,
      };
    });
  };

  // 보류함 항목 클릭 시 원래 속한 의견 보드로 스크롤 이동
  const scrollToTopic = (topicId) => {
    topicRefs.current[topicId]?.scrollIntoView({ behavior: "smooth", block: "center" });
  };

  // 사용자별 총 투표 수를 계산 (여러 항목에 분산 가능, 단 항목당 1표로 제한)
  const myVoteCount = (b) =>
    Object.values(b.votes).reduce((sum, voters) => sum + (voters.includes(name) ? 1 : 0), 0);

  // 핵심 제약: 동일 인물이 같은 포스트잇에 중복 투표 불가(토글로 취소만 가능),
  // 전체 투표권(votesPerUser) 소진 시 새 항목에 투표 불가. 이제 note.id 기준.
  const toggleVote = async (noteId) => {
    if (!name) return;
    // 투표권 한도는 최신 상태 기준으로 판정해야 한다. 예전에는 낡은 스냅샷으로 세서 한도를
    // 넘겨 투표되거나, 남의 표를 지운 값으로 덮어쓰는 일이 생겼다.
    await mutateBoard((current) => {
      const votersNow = current.votes[noteId] || [];
      const already = votersNow.includes(name);
      let nextVoters;
      if (already) {
        nextVoters = votersNow.filter((v) => v !== name);
      } else {
        if (myVoteCount(current) >= (selectedProject?.votesPerUser ?? 3)) return null;
        nextVoters = [...votersNow, name];
      }
      return { ...current, votes: { ...current.votes, [noteId]: nextVoters } };
    });
  };

  // 1인당 투표권도 STEP 안내 배너와 같은 이유로 projects 테이블 컬럼(votes_per_user)에 저장한다.
  const setVotesPerUser = async (n) => {
    if (!selectedProject || !isOwner) return;
    const { error } = await supabase.from("projects").update({ votes_per_user: n }).eq("id", selectedProject.id);
    if (error) {
      console.error("투표권 수 변경 실패(오너만 가능)", error);
      return;
    }
    setSelectedProject((prev) => (prev ? { ...prev, votesPerUser: n } : prev));
  };

  // 브라우저의 SpeechRecognition 생성자 (크롬/엣지 등은 webkit 접두어 사용)
  const getSpeechRecognition = () =>
    typeof window !== "undefined" ? window.SpeechRecognition || window.webkitSpeechRecognition : null;

  // "탭/화면 오디오도 함께 녹음" 옵션 자체를 보여줄지 판단하는 사전(soft) 필터. User-Agent 판별은
  // 참고용 힌트일 뿐이고, 실제 지원 여부의 최종 판단은 getDisplayMedia 호출 결과(하드 체크)로 한다.
  // Firefox·Safari는 API가 있어도 지원이 불안정하거나(트랙 없이 조용히 성공) UX가 크게 달라 숨긴다.
  const supportsTabAudioCaptureUA = () => {
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getDisplayMedia) return false;
    const ua = navigator.userAgent || "";
    if (/firefox/i.test(ua)) return false;
    if (/^((?!chrome|android).)*safari/i.test(ua)) return false; // Chrome/Android는 UA에 Safari도 포함하므로 이렇게 걸러야 실제 Safari만 남는다
    return true;
  };

  // 탭/화면 오디오 캡처를 시도해 마이크와 섞은 합성 트랙을 만든다. 실패하면(미지원·거부·오디오
  // 트랙 0개) 조용히 null을 돌려줘 호출부가 기존 마이크 단독 경로로 폴백하게 한다 — 여기서
  // 사용자에게 에러를 보여주지 않는다(3-1, 3-3 요구사항).
  const tryStartTabAudioMix = async () => {
    let displayStream;
    try {
      displayStream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
    } catch (e) {
      return null; // 사용자가 공유를 취소했거나 브라우저가 거부
    }
    // video:true는 API 제약상 요청만 필요할 뿐, 화면 자체는 녹화·표시하지 않으므로 즉시 정지한다.
    displayStream.getVideoTracks().forEach((t) => t.stop());
    const displayAudioTracks = displayStream.getAudioTracks();
    if (displayAudioTracks.length === 0) {
      // 하드 체크: Firefox 등은 API가 성공해도 오디오 트랙을 조용히 비워서 돌려줄 수 있다.
      displayStream.getTracks().forEach((t) => t.stop());
      return null;
    }
    let micStream;
    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      displayStream.getTracks().forEach((t) => t.stop());
      return null; // 마이크 권한 문제 — 기존 SpeechRecognition 내장 마이크 경로로 폴백
    }
    try {
      const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const dest = audioCtx.createMediaStreamDestination();
      audioCtx.createMediaStreamSource(micStream).connect(dest);
      audioCtx.createMediaStreamSource(new MediaStream(displayAudioTracks)).connect(dest);
      displayStreamRef.current = displayStream;
      micStreamRef.current = micStream;
      audioCtxRef.current = audioCtx;
      mixedDestRef.current = dest;
      return dest.stream.getAudioTracks()[0];
    } catch (e) {
      try {
        audioCtxRef.current?.close();
      } catch (e2) {
        /* noop */
      }
      displayStream.getTracks().forEach((t) => t.stop());
      micStream.getTracks().forEach((t) => t.stop());
      return null;
    }
  };

  // 합성 트랙이 준비돼 있으면 그 트랙을 그대로 파일로 저장하기 시작한다. 이 저장 파이프라인은
  // 아래 실시간 인식(recognition)이 성공하든 실패하든 독립적으로 계속 돈다(3-4 요구사항).
  const startMediaRecorderIfReady = () => {
    const dest = mixedDestRef.current;
    if (!dest) return;
    recordedChunksRef.current = [];
    let recorder;
    try {
      recorder = new MediaRecorder(dest.stream);
    } catch (e) {
      return; // MediaRecorder 미지원이면 파일 저장만 조용히 포기하고 실시간 인식은 그대로 진행
    }
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) recordedChunksRef.current.push(e.data);
    };
    recorder.onstop = () => {
      const blob = new Blob(recordedChunksRef.current, { type: recorder.mimeType || "audio/webm" });
      recordedChunksRef.current = [];
      setRecordedAudioUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return blob.size > 0 ? URL.createObjectURL(blob) : null;
      });
    };
    mediaRecorderRef.current = recorder;
    try {
      recorder.start();
    } catch (e) {
      /* noop */
    }
  };

  // 탭 오디오 관련으로 잡아둔 자원을 전부 정리한다(마이크/탭 오디오 트랙 정지, AudioContext 닫기,
  // MediaRecorder 정지 — onstop이 recordedAudioUrl을 채운다). 마이크 단독 경로에서는 애초에
  // 아무 것도 잡아둔 게 없어 호출해도 아무 일도 일어나지 않는다.
  const teardownTabAudioCapture = () => {
    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      try {
        recorder.stop();
      } catch (e) {
        /* noop */
      }
    }
    mediaRecorderRef.current = null;
    try {
      audioCtxRef.current?.close();
    } catch (e) {
      /* noop */
    }
    audioCtxRef.current = null;
    mixedDestRef.current = null;
    micStreamRef.current?.getTracks().forEach((t) => t.stop());
    micStreamRef.current = null;
    displayStreamRef.current?.getTracks().forEach((t) => t.stop());
    displayStreamRef.current = null;
  };

  // track이 없으면 오늘과 완전히 같은 마이크 단독 음성 인식이다.
  // track이 있으면(탭 오디오 합성 트랙) 실험적인 SpeechRecognition.start(track) 경로를 시도한다 —
  // 이 파라미터의 실제 지원 여부가 브라우저마다 검증되지 않아, onresult가 일정 시간 안에 오지 않거나
  // 예외/조기 종료가 나면 "중간" 단계로 보고 새 인식기를 마이크 단독으로 즉시 재시작한다(3-4 요구사항).
  const startRecognition = (track) => {
    const SR = getSpeechRecognition();
    if (!SR) {
      setSpeechSupported(false);
      return;
    }
    const recognition = new SR();
    recognition.lang = minutesLangRef.current;
    recognition.continuous = true; // 말이 잠깐 끊겨도 계속 듣는다
    recognition.interimResults = true; // 확정 전 임시 결과도 실시간으로 보여준다

    let resultReceived = false;
    let gaveUp = false; // 5초 타임아웃이 지나 마이크 단독으로 완전히 넘어갔는지
    let fallbackTimer = null;
    // 5초 안에 한 번이라도 onresult가 오면 성공(최상 단계)으로 확정한다. 그 전까지는 no-speech 같은
    // 흔한 에러로 인식기가 잠깐 끝나도(onend) 실패로 단정하지 않고 같은 track으로 재시도한다 —
    // 그렇지 않으면 회의 시작 직후의 자연스러운 침묵만으로도 "최상" 단계가 성급하게 포기돼버린다.
    const giveUpAndFallback = () => {
      if (gaveUp || recognitionRef.current !== recognition) return;
      gaveUp = true;
      if (fallbackTimer) clearTimeout(fallbackTimer);
      try {
        recognition.abort();
      } catch (e) {
        /* noop */
      }
      setRecordingTier("tab-audio-file-only");
      // abort 직후 바로 새 인식기를 시작하면 브라우저 음성 인식 서비스가 아직 안 놓아준 상태일 수
      // 있어 짧게 텀을 둔다. 그사이 사용자가 멈췄으면(wantRecordingRef가 꺼졌으면) 재시작하지 않는다.
      setTimeout(() => {
        if (!wantRecordingRef.current) return;
        startRecognition(); // track 없이 새 인식기로 — 이제부터는 기존 마이크 단독 경로와 동일
      }, 200);
    };
    if (track) {
      fallbackTimer = setTimeout(giveUpAndFallback, 5000);
    }

    recognition.onresult = (event) => {
      if (track && !resultReceived) {
        resultReceived = true;
        if (fallbackTimer) clearTimeout(fallbackTimer);
        setRecordingTier("tab-audio-full"); // start(track)이 실제로 동작함을 확인한 순간
      }
      let finalChunk = "";
      let interimChunk = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const res = event.results[i];
        if (res.isFinal) finalChunk += res[0].transcript;
        else interimChunk += res[0].transcript;
      }
      // 확정된 발화 단위(finalChunk)마다 줄바꿈으로 구분해 쌓는다. 한국어(ko-KR) 인식 결과에는
      // Web Speech API가 마침표를 붙여주지 않아서, 예전처럼 공백으로만 이어붙이면 회의 전체가
      // 문장 경계 없는 한 덩어리 텍스트가 된다 — "중복 정리"의 문장 단위 중복 제거가 전혀 못
      // 먹었던 원인이자, docx/마크다운 내보내기가 문단 하나로 뭉쳐 나오던 원인이기도 하다
      // (두 내보내기 코드 모두 minutes를 줄바꿈 기준으로 나눌 것을 이미 전제하고 있었다).
      if (finalChunk) {
        const next = (minutesRef.current ? minutesRef.current + "\n" : "") + finalChunk.trim();
        minutesRef.current = next;
        setMinutes(next);
      }
      setMinutesInterim(interimChunk);
    };

    recognition.onerror = (event) => {
      // no-speech / aborted 등은 흔한 일이므로 조용히 넘어가고(뒤이어 오는 onend에서 처리),
      // 권한 거부만 사용자에게 알린다. track 유무와 무관하게 동일하게 적용된다.
      if (event.error === "not-allowed" || event.error === "service-not-allowed") {
        wantRecordingRef.current = false;
        setMicRecording(false);
        setConfirmState({
          title: "마이크 권한 필요",
          message: "브라우저에서 마이크 사용이 차단되어 있습니다. 주소창의 자물쇠 아이콘에서 마이크를 허용해 주세요.",
          confirmLabel: "확인",
          onConfirm: () => setConfirmState(null),
        });
      }
    };

    // continuous라도 브라우저가 일정 시간 후 자동 종료할 수 있다.
    // 사용자가 여전히 "녹음 중"을 원하면 자동으로 다시 시작해 끊김 없이 이어 듣는다.
    recognition.onend = () => {
      // 모드 전환으로 교체된 옛 인스턴스는 재시작·상태변경에 관여하지 않는다(두 인식기 동시 실행 방지).
      if (recognitionRef.current !== recognition) return;
      if (track && !resultReceived) {
        if (gaveUp) return; // 이미 타임아웃으로 마이크 단독 전환을 예약해뒀다 — 여기선 아무 것도 안 한다
        if (!wantRecordingRef.current) return;
        // 5초 타임아웃 전이라면 아직 실패로 단정하지 않고 같은 track으로 다시 시도한다.
        try {
          recognition.start(track);
        } catch (e) {
          giveUpAndFallback();
        }
        return;
      }
      if (wantRecordingRef.current) {
        try {
          recognition.start();
        } catch (e) {
          /* 이미 시작된 경우 등은 무시 */
        }
      } else {
        setMicRecording(false);
      }
    };

    recognitionRef.current = recognition;
    try {
      if (track) recognition.start(track);
      else recognition.start();
      setMicRecording(true);
    } catch (e) {
      if (track) giveUpAndFallback();
      /* track 없는 중복 start 예외는 기존과 동일하게 무시 */
    }
  };

  const stopRecognition = () => {
    wantRecordingRef.current = false;
    const recognition = recognitionRef.current;
    if (recognition) {
      try {
        recognition.stop();
      } catch (e) {
        /* noop */
      }
    }
    setMicRecording(false);
    setMinutesInterim("");
  };

  // ===== 녹음 점유(한 번에 한 명) 판정 =====
  // 하트비트가 끊긴 지 오래면 녹음자가 사라진 것으로 보고 점유를 무시한다(탭 닫힘·새로고침·크래시).
  // 하트비트가 아예 없는(recordingAt=0) 데이터는 점유 개념이 없던 구버전이 남긴 값이다.
  // 이때 recordingBy도 비어 있어 "내 것도 아니고 만료도 아닌" 영구 잠금이 되므로, 만료로 취급해 정리한다.
  const recordingStale = !!board.recording && (!board.recordingAt || Date.now() - board.recordingAt > RECORDING_STALE_MS);
  const recordingHeld = !!board.recording && !recordingStale;
  const recordingOwner = board.recordingBy || "다른 참여자";
  // 내가 이 브라우저에서 녹음 중이면 잠긴 게 아니다. 이름이 같은 다른 브라우저(같은 계정 두 탭)는
  // 구분할 수 없지만, 같은 사람이라 동시 녹음이 사고로 이어질 일이 없어 허용한다.
  const recordingLockedByOther = recordingHeld && !micRecording && board.recordingBy !== name;
  // 녹취록을 고치는 동작(중복 정리·내용 지우기)은 내가 녹음 중일 때뿐 아니라 남이 녹음 중일 때도 막는다.
  // 남의 하트비트 저장이 곧 덮어써서 수정이 되돌아온 것처럼 보이기 때문.
  const minutesMutationBlocked = micRecording || recordingLockedByOther;

  // 녹음 중에는 하트비트를 주기적으로 갱신한다. 이 값이 끊기면 위 만료 판정이 점유를 풀어준다.
  // 녹취록(minutes)도 같이 저장해, 녹음 중 브라우저가 죽어도 마지막 하트비트까지는 남게 한다.
  useEffect(() => {
    if (!micRecording) return;
    const iv = setInterval(() => {
      // 하트비트는 10초마다 보드 전체를 저장하므로, 예전 구조에서는 이것만으로도 다른 참여자가
      // 그 사이에 만든 포스트잇을 지워버릴 수 있었다. 이제 최신 상태 위에 녹음 필드만 얹는다.
      mutateBoard((current) => ({
        ...current,
        recording: true,
        recordingBy: name,
        recordingAt: Date.now(),
        minutes: minutesRef.current,
      }));
    }, RECORDING_HEARTBEAT_MS);
    return () => clearInterval(iv);
  }, [micRecording, name, mutateBoard]);

  // 만료 판정은 Date.now()에 의존하는데, 녹음자가 사라지면 서버 값이 더 이상 안 바뀌어서
  // 폴링만으로는 리렌더가 일어나지 않는다(loadBoard는 값이 같으면 setBoard를 건너뛴다).
  // 그러면 잠금이 영구히 남아 보이므로, 남이 점유 중일 때만 주기적으로 리렌더를 유도한다.
  const [, setRecordingLockTick] = useState(0);
  useEffect(() => {
    if (!board.recording || micRecording) return;
    const iv = setInterval(() => setRecordingLockTick((t) => t + 1), 5000);
    return () => clearInterval(iv);
  }, [board.recording, micRecording]);

  // 죽은 점유가 감지되면(하트비트 만료) 공유 상태도 실제로 정리해준다.
  // 화면에서만 무시하고 두면 board.recording이 계속 true로 남아 "녹음 중" 배지가 사라지지 않는다.
  useEffect(() => {
    if (!recordingStale || micRecording) return;
    mutateBoard((current) => {
      if (!current.recording) return null; // 그사이 누가 이미 정리했으면 건너뛴다
      // 다시 읽어온 값이 살아있는 하트비트면(그사이 누가 녹음을 시작했다면) 건드리지 않는다
      if (current.recordingAt && Date.now() - current.recordingAt <= RECORDING_STALE_MS) return null;
      return { ...current, recording: false, recordingBy: "", recordingAt: 0 };
    });
  }, [recordingStale, micRecording, mutateBoard]);

  // 녹음을 멈추고 공유 상태를 정리한다. 일시정지와 종료는 "다음에 이어서 녹음할 생각인지"만 다르고
  // (closed 플래그) 나머지 동작(인식 정지, 녹취록 저장, 점유 해제)은 완전히 같다.
  const haltRecording = async (closed) => {
    // 저장이 끝나기 전에 "서버 값 동기화" effect가 옛 board.minutes로 minutesRef를 덮어쓰지 않도록
    // stopRecognition()의 setMicRecording(false)보다 먼저 잠금을 건다 (아래 effect 참고).
    minutesSyncSuspendRef.current = true;
    stopRecognition();
    teardownTabAudioCapture(); // 탭 오디오를 쓴 적 없으면 아무 것도 하지 않는다
    await mutateBoard((current) => ({
      ...current,
      recording: false,
      recordingBy: "",
      recordingAt: 0,
      minutesClosed: closed,
      minutes: minutesRef.current,
    }));
    minutesSyncSuspendRef.current = false;
  };

  // 일시정지: 마이크만 놓는다. 다시 누르면 지금까지의 녹취록에 이어서 쌓인다.
  const pauseRecording = () => haltRecording(false);

  // 종료: 문서에 반영하고 이 녹음 세션을 마감한다. 녹취록 자체는 지우지 않는다
  // (문서의 원본이고, 비우려면 "내용 지우기"가 따로 있다) — 다시 녹음하면 새 세션으로 이어붙인다.
  const endRecording = () => haltRecording(true);

  // 녹음 시작(처음 시작 / 일시정지 후 이어서 / 종료 후 새로).
  // board.recording은 참여자 모두에게 보이는 공유 "녹음 중" 배지이고,
  // 실제 음성 인식은 버튼을 누른 이 브라우저에서만 로컬로 동작한다.
  const startRecording = async () => {
    // 다른 사람이 이미 녹음 중이면 시작하지 않는다(동시 녹음 시 녹취록이 서로를 덮어쓴다).
    if (recordingLockedByOther) {
      setConfirmState({
        title: "이미 녹음 중입니다",
        message: `${recordingOwner}님이 회의록을 녹음하고 있습니다. 한 회의에서는 한 사람만 녹음할 수 있어요. 그 분이 녹음을 멈추면 시작할 수 있습니다.`,
        confirmLabel: "확인",
        onConfirm: () => setConfirmState(null),
      });
      return;
    }

    const SR = getSpeechRecognition();
    if (!SR) {
      setSpeechSupported(false);
      setConfirmState({
        title: "지원하지 않는 브라우저",
        message: "이 브라우저는 음성 인식(Web Speech API)을 지원하지 않습니다. Chrome 또는 Edge에서 이용해 주세요.",
        confirmLabel: "확인",
        onConfirm: () => setConfirmState(null),
      });
      return;
    }

    // 탭 오디오는 사용자가 체크박스로 켰고 브라우저도 지원 힌트가 있을 때만 시도한다.
    // 껐거나 미지원이면 아래 proceed()가 오늘과 완전히 같은 마이크 단독 경로로만 간다.
    const wantsTabAudio = tabAudioOption && supportsTabAudioCaptureUA();

    const proceed = async () => {
      minutesSyncSuspendRef.current = true;
      wantRecordingRef.current = true;
      // 이전 세션에서 남은 파일 링크는 새 세션을 시작하면 더 이상 유효한 안내가 아니므로 정리한다.
      setRecordedAudioUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return null;
      });
      setRecordingTier(wantsTabAudio ? null : "mic-only");

      let mergedTrack = null;
      if (wantsTabAudio) {
        mergedTrack = await tryStartTabAudioMix();
        if (mergedTrack) {
          startMediaRecorderIfReady();
        } else {
          setRecordingTier("mic-only"); // 캡처 자체가 실패/거부/미지원 — 조용히 폴백(3-1)
        }
      }
      startRecognition(mergedTrack || undefined);
      setMinutesOpen(true); // 결과 확인·저장용 패널을 확실히 보여준다

      // 점유자(recordingBy)와 하트비트 시각을 심어 다른 참여자의 시작 버튼을 잠근다.
      await mutateBoard((current) => ({
        ...current,
        recording: true,
        recordingBy: name,
        recordingAt: Date.now(),
        minutesClosed: false, // 다시 녹음을 시작하면 마감 상태를 푼다
        minutes: minutesRef.current,
        recordingConsentAck: current.recordingConsentAck || wantsTabAudio,
      }));
      minutesSyncSuspendRef.current = false;
    };

    // 탭 오디오를 처음 켜는 프로젝트라면, 캡처를 시도하기 전에 참여자 고지 여부를 한 번 확인한다
    // (프로젝트당 1회 — 이미 확인됐으면 다시 묻지 않는다). 마이크 단독일 때는 기존과 동일하게
    // 이 확인 절차 자체가 없다.
    if (wantsTabAudio && !board.recordingConsentAck) {
      setConfirmState({
        title: "녹음 시작 전 확인",
        message:
          "탭/화면 오디오를 함께 녹음하면 상대방 발화까지 기록에 남습니다. 참여자 전원에게 녹음 사실을 미리 알렸나요?\n\n곧 뜨는 공유 화면 선택 창에서 '오디오 공유'를 꼭 체크해 주세요. 헤드폰 없이 쓰면 스피커 소리를 마이크가 다시 주워 내용이 중복될 수 있어요.",
        confirmLabel: "네, 알렸습니다 · 시작",
        onConfirm: () => {
          setConfirmState(null);
          proceed();
        },
        onCancel: () => setConfirmState(null),
      });
      return;
    }

    await proceed();
  };

  // ===== 회의록(minutes) 액션 =====
  const copyMinutes = async () => {
    try {
      await navigator.clipboard.writeText(minutesRef.current.trim());
    } catch (e) {
      /* 클립보드 권한 없을 때 조용히 무시 */
    }
  };

  // 전체 회의 녹취록을 .txt 파일로 다운로드
  const downloadMinutes = () => {
    const text = minutesRef.current.trim();
    if (!text) return;
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${selectedProject?.title || "회의록"}-회의록.txt`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  // 회의록 내용 지우기(문서에도 반영되도록 board.minutes까지 비운다)
  const clearMinutes = async () => {
    minutesRef.current = "";
    setMinutes("");
    setMinutesInterim("");
    await mutateBoard((current) => ({ ...current, minutes: "" }));
  };

  // 회의록 단순 정리(외부 API 없이 클라이언트에서만): 반복된 문장과 붙어서 중복된 단어를 걷어낸다.
  // ※ 요약/핵심 추출이 아니라 "잡음성 중복 제거" 수준이다. 결과는 문서 "회의 녹취록"에 그대로 반영된다.
  const cleanupMinutes = async () => {
    const raw = minutesRef.current || "";
    if (!raw.trim()) return;
    // 1) 문장 단위로 나눈다(문장부호/줄바꿈 기준). 부호가 없으면 통째로 한 덩어리가 된다.
    const segments = raw
      .split(/(?<=[.!?。？！])\s+|\n+/)
      .map((s) => s.trim())
      .filter(Boolean);
    const seen = new Set();
    const out = [];
    for (let seg of segments) {
      // 2) 붙어서 반복된 동일 단어 축약: "그 그 그 안건" -> "그 안건"
      //    (\b는 한글에 안 먹으므로, 반복 토큰 뒤가 공백/끝인지 lookahead로 확인)
      seg = seg.replace(/(\S+)(?:\s+\1(?=\s|$))+/g, "$1").replace(/\s{2,}/g, " ").trim();
      // 3) 공백·문장부호를 무시한 정규화 기준으로 중복 문장 제거(첫 등장 순서 유지)
      const norm = seg.replace(/[\s.,!?。、·]/g, "").toLowerCase();
      if (!norm || seen.has(norm)) continue;
      seen.add(norm);
      out.push(seg);
    }
    const cleaned = out.join("\n");
    if (cleaned === raw) return; // 바뀐 게 없으면 저장 생략
    minutesRef.current = cleaned;
    setMinutes(cleaned);
    await mutateBoard((current) => ({ ...current, minutes: cleaned }));
  };

  // 회의록 녹음 중이 아닐 때는 board.minutes(공유 저장본)를 로컬 버퍼에 동기화한다.
  // 이렇게 하면 새로고침·재접속 후에도 회의록 패널과 "이어서 녹음"이 이어진다.
  // (녹음 중에는 로컬이 실시간으로 자라므로 덮어쓰지 않는다.)
  useEffect(() => {
    if (micRecording) return; // 녹음 중에는 로컬 버퍼가 실시간으로 자라므로 덮어쓰지 않는다
    if (minutesSyncSuspendRef.current) return; // 정지 저장(load+save)이 끝나기 전에는 덮어쓰지 않는다
    const bm = board.minutes || "";
    if (bm !== minutesRef.current) {
      minutesRef.current = bm;
      setMinutes(bm);
    }
  }, [board.minutes, micRecording]);

  // 컴포넌트 언마운트 시 인식이 계속 돌지 않도록 정리
  useEffect(() => {
    return () => {
      wantRecordingRef.current = false;
      if (recognitionRef.current) {
        try {
          recognitionRef.current.stop();
        } catch (e) {
          /* noop */
        }
      }
    };
  }, []);

  // "이미지로 저장": 현재 보고 있는 탭에 실제로 렌더링된 화면 전체(스크롤 영역 포함)를 그대로 캡처한다
  // 작업 화면 헤더의 "링크 복사" — 목록 화면의 링크 복사와 동일한 형식(?p=id)
  const copyBoardLink = async () => {
    if (!selectedProject) return;
    const url = `${window.location.origin}${window.location.pathname}?p=${selectedProject.id}`;
    await navigator.clipboard.writeText(url);
    setBoardLinkCopied(true);
    setTimeout(() => setBoardLinkCopied(false), 1800);
  };

  const downloadPhaseImage = async () => {
    const node = phaseContentRef.current;
    if (!node) return;
    const dataUrl = await toPng(node, { backgroundColor: "#ffffff", pixelRatio: 2 });
    const link = document.createElement("a");
    link.download = `${selectedProject.title}-${PHASE_LABELS[activeTab] || "화면"}.png`;
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

  // 4번(문서): PDF로 내려받기. 서버 없이 클라이언트에서만 만든다.
  // 텍스트를 PDF에 직접 쓰는 대신 화면을 캡처한 이미지를 넣는다 — jsPDF 기본 폰트에는 한글 글리프가
  // 없어서 텍스트로 쓰면 전부 빈 사각형이 되고, 한글 폰트를 임베드하면 번들이 수 MB 늘어난다.
  // 브라우저가 이미 화면에 그려놓은 것을 그대로 담으니 폰트 문제가 아예 생기지 않고 화면과 100% 같다.
  // jsPDF는 이 버튼을 누를 때만 동적 import한다(안 쓰는 사용자가 로딩 비용을 치르지 않게).
  const downloadDocPdf = async () => {
    const node = docContentRef.current;
    if (!node) return;
    setPdfDownloading(true);
    try {
      const { jsPDF } = await import("jspdf");
      const dataUrl = await toPng(node, { backgroundColor: "#ffffff", pixelRatio: 2 });
      // 이미지 실제 픽셀 크기를 알아야 A4 폭에 맞춘 축소 비율과 총 높이를 계산할 수 있다.
      const img = await new Promise((resolve, reject) => {
        const el = new Image();
        el.onload = () => resolve(el);
        el.onerror = reject;
        el.src = dataUrl;
      });

      const pdf = new jsPDF({ unit: "pt", format: "a4" });
      const margin = 24;
      const pageW = pdf.internal.pageSize.getWidth();
      const pageH = pdf.internal.pageSize.getHeight();
      const drawW = pageW - margin * 2;
      const drawH = (img.height / img.width) * drawW; // 폭을 A4에 맞추고 비율 유지
      const usableH = pageH - margin * 2;

      // 문서가 한 장보다 길면 같은 이미지를 페이지마다 위로 밀어 올려 그린다.
      // 페이지 밖으로 나간 부분은 PDF가 잘라내므로, 결과적으로 세로로 이어지는 여러 장이 된다.
      // 2pt(약 0.7mm)는 남는 것으로 보지 않는다 — 딱 한 장에 들어차는 문서가 반올림 오차 때문에
      // 머리카락 한 올 넘쳐서 거의 빈 마지막 장이 붙는 걸 막는다.
      const pageCount = Math.max(1, Math.ceil((drawH - 2) / usableH));
      for (let i = 0; i < pageCount; i++) {
        if (i > 0) pdf.addPage();
        pdf.addImage(dataUrl, "PNG", margin, margin - i * usableH, drawW, drawH);
      }
      pdf.save(`${selectedProject.title}-${docType === "result" ? "결과" : "과정"}문서.pdf`);
    } finally {
      setPdfDownloading(false);
    }
  };

  // 4번(문서): 표 중심 문서를 Word(.docx) 파일로 내려받기. docType으로 "과정" 문서와 "결과"(TOP 5) 문서를 구분한다.
  const downloadDoc = async (type) => {
    setDocxDownloading(true);
    try {
      const doc = buildDocDocx(selectedProject, board, type);
      const blob = await Packer.toBlob(doc);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.download = `${selectedProject.title}-${type === "result" ? "결과" : "과정"}문서.docx`;
      link.href = url;
      link.click();
      URL.revokeObjectURL(url);
    } finally {
      setDocxDownloading(false);
    }
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

  const copyDocPrompt = async (text) => {
    await navigator.clipboard.writeText(text);
    setPromptCopied(true);
    setTimeout(() => setPromptCopied(false), 1800);
  };

  // 미리보기·글자 수·복사가 모두 참조하는 최종 프롬프트 문자열.
  // 사용자가 미리보기에서 직접 고쳤으면 그 값(promptDraft)을 쓰고, 아니면 옵션대로 새로 조립한다.
  // 패널이 닫혀 있으면 문서 전체를 문자열로 조립하는 비용을 매 렌더마다 치를 이유가 없어 건너뛴다.
  const promptText = promptOpen ? promptDraft ?? buildDocPrompt(selectedProject, board, docType, promptPreset, promptInclude) : "";

  // ---- 최상단 로그인 게이트: selectedProject가 어떤 경로(목록 클릭/공유 링크)로 설정됐든
  // 로그인 전에는 절대 보드로 들어갈 수 없다("팀원도 로그인 필수, 익명 참여 폐지"). ----
  // 로그인 여부 확인이 끝나기 전에는 로그인/목록 화면이 잠깐 깜빡이지 않도록 대기
  if (authLoading) {
    return (
      <div>
        <TopBar onProjects={backToProjects} />
        <div style={{ textAlign: "center", padding: "80px 24px", color: "#a19c95", fontSize: 14 }}>불러오는 중...</div>
      </div>
    );
  }
  if (!user) {
    return (
      <div>
        <TopBar onProjects={backToProjects} />
        <div style={{ minHeight: "70vh", display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
          <div style={{ textAlign: "center", maxWidth: 380 }}>
            {/* sessionExpired: 사용자가 직접 로그아웃한 게 아니라(1시간 무활동, 구글 토큰 갱신 실패
                등으로) 세션이 예상 못 하게 사라진 경우. 평소의 로그인 유도 문구 대신 "왜 여기로
                돌아왔는지"부터 알려준다 — 안 그러면 방금까지 잘 쓰고 있었는데 갑자기 로그인 화면이
                떠서 뭐가 잘못됐나 당황하게 된다. */}
            {sessionExpired && (
              <div style={{ background: "#fdeaea", border: "1px solid #ffcaca", borderRadius: 10, padding: "10px 14px", marginBottom: 18, fontSize: 13.5, color: "#c0392b", fontWeight: 600 }}>
                로그인이 만료되었습니다. 다시 로그인해주세요.
              </div>
            )}
            <h1 style={{ fontSize: 24, fontWeight: 800, letterSpacing: "-.02em", margin: "0 0 10px" }}>
              {sharedProjectId ? "회의에 참여하기" : "내 프로젝트"}
            </h1>
            <p style={{ fontSize: 14.5, color: "#8a857f", margin: "0 0 24px", lineHeight: 1.6 }}>
              {sharedProjectId
                ? "이 회의에 참여하려면 구글 계정으로 로그인해주세요."
                : "구글 계정으로 로그인하면 내가 만든 프로젝트를 모아 관리할 수 있어요."}
            </p>
            <button
              onClick={signInWithGoogle}
              style={{ display: "inline-flex", alignItems: "center", gap: 10, background: "#242322", color: "#fff", border: "none", borderRadius: 11, padding: "13px 22px", fontWeight: 700, fontSize: 15, cursor: "pointer" }}
            >
              <svg width="18" height="18" viewBox="0 0 48 48">
                <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.9 32.6 29.4 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34.6 6.5 29.6 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.2-.1-2.4-.4-3.5z"/>
                <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.5 15.9 18.9 13 24 13c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34.6 6.5 29.6 4 24 4c-7.5 0-14 4.2-17.7 10.7z"/>
                <path fill="#4CAF50" d="M24 44c5.5 0 10.4-1.9 14.2-5.1l-6.6-5.4C29.6 35.4 26.9 36 24 36c-5.4 0-9.9-3.4-11.3-8.1l-6.5 5C9.9 39.7 16.4 44 24 44z"/>
                <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-1 3-3.2 5.4-6 6.9l6.6 5.4C39.5 37.3 44 31.5 44 24c0-1.2-.1-2.4-.4-3.5z"/>
              </svg>
              Google로 계속하기
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ---- 화면 1: 프로젝트 목록 / 생성 (이 아래부터는 항상 로그인된 상태) ----
  if (!selectedProject) {
    // 공유 링크(?p=id)로 들어왔는데 그 id의 프로젝트가 실제로 없는 경우(삭제됐거나, 링크 오타 등)
    if (sharedProjectId && sharedProjectNotFound) {
      return (
        <div>
          <TopBar onProjects={backToProjects} user={user} onSignOut={signOut} displayName={name} />
          <div style={{ minHeight: "60vh", display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
            <div style={{ textAlign: "center", maxWidth: 380 }}>
              <h1 style={{ fontSize: 22, fontWeight: 800, letterSpacing: "-.02em", margin: "0 0 10px" }}>프로젝트를 찾을 수 없습니다</h1>
              <p style={{ fontSize: 14.5, color: "#8a857f", margin: "0 0 24px", lineHeight: 1.6 }}>
                링크가 잘못됐거나, 오너가 이 프로젝트를 삭제했을 수 있어요.
              </p>
              <button
                onClick={backToProjects}
                style={{ background: "#242322", color: "#fff", border: "none", borderRadius: 11, padding: "12px 22px", fontWeight: 700, fontSize: 14.5, cursor: "pointer" }}
              >
                내 프로젝트로 이동
              </button>
            </div>
          </div>
        </div>
      );
    }
    // 공유 링크(?p=id)로 들어왔는데 아직 그 프로젝트를 조회 중인 상태
    if (sharedProjectId) {
      return (
        <div>
          <TopBar onProjects={backToProjects} user={user} onSignOut={signOut} displayName={name} />
          <div style={{ textAlign: "center", padding: "80px 24px", color: "#a19c95", fontSize: 14 }}>프로젝트를 불러오는 중입니다...</div>
        </div>
      );
    }
    return (
      <div>
        <TopBar onProjects={backToProjects} user={user} onSignOut={signOut} displayName={name} />
        <div style={{ maxWidth: 820, margin: "0 auto", padding: "40px 24px 80px" }}>
          <h1 style={{ fontSize: 28, fontWeight: 800, letterSpacing: "-.03em", margin: "0 0 7px" }}>내 프로젝트</h1>
          <div style={{ fontSize: 15, color: "#8a857f", marginBottom: 28 }}>
            회의 하나가 프로젝트 하나입니다. 새로 시작하거나 이어서 진행하세요.
          </div>

          {/* 새 프로젝트 만들기 카드 */}
          <div style={{ background: "#fff", border: "1px solid rgba(36,35,34,.09)", borderRadius: 16, padding: 20, boxShadow: "0 1px 3px rgba(0,0,0,.05)", marginBottom: 28 }}>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              <input
                value={newProjectTitle}
                onChange={(e) => setNewProjectTitle(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && createProject()}
                placeholder="프로젝트 이름 (필수)"
                style={{ flex: "2 1 180px", border: "1px solid rgba(36,35,34,.14)", borderRadius: 10, padding: "12px 14px", fontSize: 14, outline: "none", boxSizing: "border-box" }}
              />
              <input
                value={newProjectGoal}
                onChange={(e) => setNewProjectGoal(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && createProject()}
                placeholder="목표 한 줄 (선택)"
                style={{ flex: "3 1 220px", border: "1px solid rgba(36,35,34,.14)", borderRadius: 10, padding: "12px 14px", fontSize: 14, outline: "none", boxSizing: "border-box" }}
              />
              <button
                onClick={createProject}
                style={{ background: "#242322", color: "#fff", border: "none", borderRadius: 10, padding: "12px 20px", fontWeight: 600, fontSize: 14, cursor: "pointer", whiteSpace: "nowrap" }}
              >
                + 새 프로젝트
              </button>
            </div>
          </div>

          {projects === null && <div style={{ color: "#a19c95", fontSize: 14 }}>불러오는 중...</div>}
          {/* 참여 중인 프로젝트가 있으면 "없습니다" 문구는 숨긴다 — 아래에 목록이 보이는데 위에서
              없다고 말하면 서로 어긋나 보인다(내가 만든 게 없을 뿐, 참여한 회의는 있는 상태). */}
          {projects && projects.length === 0 && (joinedProjects || []).filter((p) => !user || p.ownerId !== user.id).length === 0 && (
            <div style={{ color: "#a19c95", fontSize: 14, textAlign: "center", padding: "30px 0" }}>아직 생성된 프로젝트가 없습니다.</div>
          )}
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
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
                    background: "#fff",
                    border: `1px solid ${p.pinned ? "rgba(234,185,122,.5)" : "rgba(36,35,34,.09)"}`,
                    borderRadius: 14,
                    padding: "18px 20px",
                    boxShadow: "0 1px 3px rgba(0,0,0,.04)",
                    display: "flex",
                    alignItems: "center",
                    gap: 16,
                  }}
                >
                  <span
                    onClick={(e) => {
                      e.stopPropagation();
                      togglePinProject(p.id);
                    }}
                    title={p.pinned ? "고정 해제" : "고정"}
                    style={{ fontSize: 18, cursor: "pointer", flexShrink: 0, filter: p.pinned ? "none" : "grayscale(1) opacity(0.35)" }}
                  >
                    📌
                  </span>
                  {editingProjectId === p.id ? (
                    <>
                      <div style={{ flex: 1, display: "flex", gap: 8, minWidth: 0 }}>
                        <input
                          value={editTitle}
                          onChange={(e) => setEditTitle(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") saveEditProject(p.id);
                            if (e.key === "Escape") cancelEditProject();
                          }}
                          placeholder="프로젝트 이름 (필수)"
                          autoFocus
                          style={{ flex: "1 1 140px", border: "1px solid rgba(36,35,34,.14)", borderRadius: 8, padding: "8px 10px", fontSize: 14, outline: "none", boxSizing: "border-box", minWidth: 0 }}
                        />
                        <input
                          value={editGoal}
                          onChange={(e) => setEditGoal(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") saveEditProject(p.id);
                            if (e.key === "Escape") cancelEditProject();
                          }}
                          placeholder="목표 한 줄 (선택)"
                          style={{ flex: "2 1 180px", border: "1px solid rgba(36,35,34,.14)", borderRadius: 8, padding: "8px 10px", fontSize: 14, outline: "none", boxSizing: "border-box", minWidth: 0 }}
                        />
                      </div>
                      <button
                        onClick={() => saveEditProject(p.id)}
                        style={{ background: "#242322", color: "#fff", border: "none", borderRadius: 8, padding: "8px 14px", fontSize: 13, fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap", flexShrink: 0 }}
                      >
                        저장
                      </button>
                      <button
                        onClick={cancelEditProject}
                        style={{ background: "none", border: "1px solid rgba(36,35,34,.1)", borderRadius: 8, padding: "8px 14px", fontSize: 13, fontWeight: 600, cursor: "pointer", color: "#8a857f", whiteSpace: "nowrap", flexShrink: 0 }}
                      >
                        취소
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        onClick={() => openProject(p)}
                        style={{ flex: 1, textAlign: "left", background: "none", border: "none", cursor: "pointer", padding: 0, minWidth: 0 }}
                      >
                        <div style={{ fontWeight: 700, fontSize: 16, letterSpacing: "-.01em", marginBottom: 7, color: "#242322" }}>{p.title}</div>
                        <div style={{ fontSize: 14, color: "#8a857f" }}>
                          {new Date(p.createdAt).toLocaleDateString("ko-KR")} 생성{p.goal ? ` · ${p.goal}` : ""}
                        </div>
                      </button>
                      <button
                        onClick={() => openProject(p)}
                        style={{ background: "#ffffff", border: "1px solid rgba(36,35,34,.1)", borderRadius: 8, padding: "8px 14px", fontSize: 13, fontWeight: 600, cursor: "pointer", color: "#242322", whiteSpace: "nowrap", flexShrink: 0 }}
                      >
                        열기
                      </button>
                      <button
                        onClick={async (e) => {
                          e.stopPropagation();
                          const url = `${window.location.origin}${window.location.pathname}?p=${p.id}`;
                          await navigator.clipboard.writeText(url);
                          setCopiedLinkId(p.id);
                          setTimeout(() => setCopiedLinkId((cur) => (cur === p.id ? null : cur)), 1800);
                        }}
                        title="팀원과 공유할 링크 복사 (로그인 없이 이 프로젝트로 바로 들어옵니다)"
                        style={{ background: copiedLinkId === p.id ? "#e6f7f1" : "#ffffff", border: `1px solid ${copiedLinkId === p.id ? "#a9e6d3" : "rgba(36,35,34,.1)"}`, borderRadius: 8, padding: "8px 14px", fontSize: 13, fontWeight: 600, cursor: "pointer", color: copiedLinkId === p.id ? "#1e7a4d" : "#242322", whiteSpace: "nowrap", flexShrink: 0 }}
                      >
                        {copiedLinkId === p.id ? "✓ 복사됨" : "링크 복사"}
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          startEditProject(p);
                        }}
                        title="수정"
                        style={{ background: "none", border: "none", cursor: "pointer", color: "#c4bfb8", padding: 6, flexShrink: 0, display: "flex" }}
                      >
                        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
                        </svg>
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
                        title="삭제"
                        style={{ background: "none", border: "none", cursor: "pointer", color: "#c4bfb8", padding: 6, flexShrink: 0, display: "flex" }}
                      >
                        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <polyline points="3 6 5 6 21 6" />
                          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                        </svg>
                      </button>
                    </>
                  )}
                </motion.div>
              ))}
            </AnimatePresence>
          </div>

          {/* 공유 링크로 참여한 프로젝트. 프로젝트 목록은 owner_id 기준이라 리더가 만든 프로젝트는
              위 목록에 절대 나타나지 않는다 — 그래서 게스트에게는 이 섹션이 유일한 재진입로다.
              내가 소유한 것은 위에 이미 있으니 제외한다. 고정·삭제는 오너의 것이라 여기선 제공하지 않는다. */}
          {(() => {
            const joined = (joinedProjects || []).filter((p) => !user || p.ownerId !== user.id);
            if (joined.length === 0) return null;
            return (
              <div style={{ marginTop: 34 }}>
                <h2 style={{ fontSize: 17, fontWeight: 800, letterSpacing: "-.02em", margin: "0 0 4px" }}>참여 중인 프로젝트</h2>
                <p style={{ fontSize: 13.5, color: "#8a857f", margin: "0 0 14px" }}>
                  공유 링크로 참여한 회의입니다. 최근에 열어본 순서예요.
                </p>
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  {joined.map((p) => (
                    <div
                      key={p.id}
                      style={{
                        background: "#fff",
                        border: "1px solid rgba(36,35,34,.09)",
                        borderRadius: 14,
                        padding: "18px 20px",
                        boxShadow: "0 1px 3px rgba(0,0,0,.04)",
                        display: "flex",
                        alignItems: "center",
                        gap: 16,
                      }}
                    >
                      <span
                        title="공유 링크로 참여한 프로젝트"
                        style={{ fontSize: 12, fontWeight: 700, color: "#4f3fd6", background: "#ece9fc", borderRadius: 999, padding: "4px 10px", flexShrink: 0, whiteSpace: "nowrap" }}
                      >
                        참여
                      </span>
                      <button
                        onClick={() => openProject(p)}
                        style={{ flex: 1, textAlign: "left", background: "none", border: "none", cursor: "pointer", padding: 0, minWidth: 0 }}
                      >
                        <div style={{ fontWeight: 700, fontSize: 16, letterSpacing: "-.01em", marginBottom: 7, color: "#242322" }}>{p.title}</div>
                        <div style={{ fontSize: 14, color: "#8a857f" }}>
                          {new Date(p.createdAt).toLocaleDateString("ko-KR")} 생성{p.goal ? ` · ${p.goal}` : ""}
                        </div>
                      </button>
                      <button
                        onClick={() => openProject(p)}
                        style={{ background: "#ffffff", border: "1px solid rgba(36,35,34,.1)", borderRadius: 8, padding: "8px 14px", fontSize: 13, fontWeight: 600, cursor: "pointer", color: "#242322", whiteSpace: "nowrap", flexShrink: 0 }}
                      >
                        열기
                      </button>
                      <button
                        onClick={async () => {
                          const url = `${window.location.origin}${window.location.pathname}?p=${p.id}`;
                          await navigator.clipboard.writeText(url);
                          setCopiedLinkId(p.id);
                          setTimeout(() => setCopiedLinkId((cur) => (cur === p.id ? null : cur)), 1800);
                        }}
                        title="이 회의로 들어오는 링크 복사"
                        style={{ background: copiedLinkId === p.id ? "#e6f7f1" : "#ffffff", border: `1px solid ${copiedLinkId === p.id ? "#a9e6d3" : "rgba(36,35,34,.1)"}`, borderRadius: 8, padding: "8px 14px", fontSize: 13, fontWeight: 600, cursor: "pointer", color: copiedLinkId === p.id ? "#1e7a4d" : "#242322", whiteSpace: "nowrap", flexShrink: 0 }}
                      >
                        {copiedLinkId === p.id ? "✓ 복사됨" : "링크 복사"}
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            );
          })()}
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

  // (예전 "화면 2: 참여자 이름 입력"은 폐지 — 팀원도 로그인이 필수가 되면서, 참여 신원이
  // 자동으로 구글 계정 표시 이름이 되어 이름을 따로 입력받을 필요가 없어졌다. 보드 등록은
  // 아래 useEffect의 자동 참여 로직이 대신한다.)

  // 로그인한 사용자가 이 프로젝트의 오너인지. STEP 안내 배너 편집·1인당 투표권 조정은 오너만 가능
  // (실제 강제는 projects 테이블의 트리거가 하고, 이건 그에 맞춘 UI 숨김/비활성화용).
  const isOwner = !!(user && selectedProject && selectedProject.ownerId === user.id);
  const votesLeft = selectedProject.votesPerUser - myVoteCount(board);
  const problemNotesAll = board.notes.filter((n) => n.isProblem);
  const parkedNotesAll = board.notes.filter((n) => n.isParked); // 보류함: 모든 의견 보드를 통틀어 보류된 항목
  // 우선순위 결과 탭: 득표순, 동점이면 문제로 표시된 시점이 빠른 순 (buildDocModel의 결과 문서 TOP 목록과 동일 기준)
  const rankedProblems = sortProblemsByVotesEarliestFirst(problemNotesAll, board.votes);
  // 문제 정리 탭: 득표순, 동점이면 문제로 표시된 시점이 최근인 순 (buildDocModel의 과정 문서 문제 정리 표와 동일 기준)
  const problemNotesSorted = sortProblemsByVotesMostRecentFirst(problemNotesAll, board.votes);
  // 스냅샷을 열어보는 중이면 그 시점에 굳혀둔 값을, 아니면 현재 보드에서 계산한 값을 문서에 넣는다.
  // 문서 본문 JSX는 docModel만 보고 그리므로, 이 한 줄 교체로 같은 화면이 스냅샷 뷰어가 된다.
  const viewingSnapshot = (board.snapshots || []).find((s) => s.id === viewingSnapshotId) || null;
  const docModel = viewingSnapshot ? viewingSnapshot.model : buildDocModel(selectedProject, board);
  // 고정된 문서는 "그때 그대로"여야 하므로 편집 입력을 읽기 전용으로 내린다.
  const docReadOnly = !!viewingSnapshot;
  const shownDocType = viewingSnapshot ? viewingSnapshot.docType : docType;
  const minutesRecording = micRecording; // 녹음은 회의록 한 종류뿐

  // 포스트잇 카드 렌더 (문제 그룹/일반 그룹에서 공통 사용)
  const renderNoteCard = (note) => {
    const isSel = selected.includes(note.id);
    const noteColor = board.users[note.authors[0]]?.color || PALETTE[0];
    const voters = board.votes[note.id] || [];
    const iVoted = voters.includes(name);
    const voteDisabled = !iVoted && votesLeft <= 0;
    // "문제로"·"보류"는 이미 정리가 끝난(또는 나중으로 미룬) 상태로 보고 병합 선택 대상에서 뺀다 —
    // 병합은 "아직 정리 안 된 원본 의견을 하나로 합치는" 단계라, 이미 다음 단계로 넘어간 항목을
    // 여기서 또 합치면 문제 정리·투표 맥락이 흐트러진다.
    const mergeExcluded = note.isProblem || note.isParked;
    return (
      <motion.div
        key={note.id}
        {...popIn}
        onClick={() => mergeMode && !mergeExcluded && toggleSelect(note.id, note.topicId)}
        title={mergeMode && mergeExcluded ? "문제로 표시되었거나 보류된 항목은 병합할 수 없습니다" : undefined}
        style={{
          flex: "0 0 190px",
          width: 190,
          maxWidth: "100%",
          background: noteColor.bg,
          color: "#242322",
          borderRadius: 6,
          boxShadow: "0 2px 8px rgba(36,35,34,.09)",
          opacity: mergeMode && mergeExcluded ? 0.5 : 1,
          border: isSel
            ? "2px solid #0066ff"
            : note.isProblem
            ? "2px solid #EA7D7A"
            : note.isParked
            ? "1px dashed rgba(36,35,34,.35)"
            : "1px solid rgba(36,35,34,.06)",
          cursor: mergeMode ? (mergeExcluded ? "not-allowed" : "pointer") : "default",
          display: "flex",
          flexDirection: "column",
          boxSizing: "border-box",
          padding: "12px 12px 8px",
          position: "relative",
        }}
      >
        {/* 병합 모드 선택 체크박스 */}
        {mergeMode && (
          <span
            style={{
              position: "absolute",
              top: 8,
              right: 8,
              width: 18,
              height: 18,
              borderRadius: 5,
              border: `2px solid ${isSel ? "#0066ff" : "rgba(36,35,34,.3)"}`,
              background: isSel ? "#0066ff" : "rgba(255,255,255,.6)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "#fff",
              fontSize: 12,
              fontWeight: 800,
            }}
          >
            {isSel ? "✓" : ""}
          </span>
        )}
        {/* 삭제 × (편집 모드에서만) */}
        {!mergeMode && (
          <span
            onClick={(e) => {
              e.stopPropagation();
              deleteNote(note.id);
            }}
            style={{ position: "absolute", top: 6, right: 8, cursor: "pointer", color: "rgba(36,35,34,.4)", fontSize: 15, lineHeight: 1 }}
            title="삭제"
          >
            ×
          </span>
        )}

        {/* 4번: 병합 모드에서는 읽기전용 div, 아니면 자동 높이 textarea */}
        {mergeMode ? (
          <div
            style={{
              fontSize: 14.5,
              fontWeight: 500,
              lineHeight: 1.45,
              color: "#242322",
              minHeight: 20,
              paddingRight: 22,
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
            }}
          >
            {note.text || <span style={{ opacity: 0.5 }}>(빈 포스트잇)</span>}
          </div>
        ) : (
          <textarea
            value={note.text}
            placeholder="자유롭게 적어보세요"
            data-note-id={note.id}
            ref={noteTextareaRef}
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
              fontSize: 14.5,
              fontWeight: 500,
              lineHeight: 1.45,
              color: "#242322",
              padding: 0,
              paddingRight: 14,
              boxSizing: "border-box",
              wordBreak: "break-word",
            }}
          />
        )}

        {/* 하단: 작성자(좌) + 상태/투표(우) — 글자 수와 무관하게 카드 맨 아래에 고정 */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6, marginTop: "auto", paddingTop: 10 }}>
          <span style={{ fontSize: 11, fontWeight: 700, color: "rgba(36,35,34,.55)" }}>{note.authors.join(", ")}</span>
          {!mergeMode && (
            <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
              {/* 7번: 문제 포스트잇에 바로 투표 */}
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
                    background: iVoted ? "#242322" : "rgba(255,255,255,.7)",
                    color: iVoted ? "#fff" : "#57534e",
                    borderRadius: 6,
                    fontSize: 11.5,
                    padding: "3px 9px",
                    cursor: voteDisabled ? "default" : "pointer",
                    opacity: voteDisabled ? 0.45 : 1,
                    fontWeight: 700,
                    whiteSpace: "nowrap",
                  }}
                >
                  {iVoted ? "✓ 투표" : "투표"} {voters.length > 0 ? voters.length : ""}
                </button>
              )}
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  toggleProblem(note.id);
                }}
                title={note.isProblem ? "문제 표시 해제" : "문제로 표시"}
                style={{
                  border: "none",
                  background: "rgba(255,255,255,.65)",
                  color: note.isProblem ? "#57534e" : "#B52B1B",
                  borderRadius: 6,
                  fontSize: 12,
                  padding: "3px 8px",
                  cursor: "pointer",
                  fontWeight: 700,
                }}
              >
                {note.isProblem ? "해제" : "문제로"}
              </button>
              {/* 문제 포스트잇에는 보류 버튼을 숨겨 공간 확보 (문제/보류는 상호배타라 어차피 보류 시 문제 해제됨) */}
              {!note.isProblem && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleParked(note.id);
                  }}
                  title={note.isParked ? "보류 해제" : "나중에 다시 논의 (보류)"}
                  style={{
                    border: "none",
                    background: "rgba(255,255,255,.5)",
                    color: "#57534e",
                    borderRadius: 6,
                    fontSize: 12,
                    padding: "3px 8px",
                    cursor: "pointer",
                    fontWeight: 600,
                  }}
                >
                  {note.isParked ? "복귀" : "보류"}
                </button>
              )}
            </div>
          )}
        </div>
      </motion.div>
    );
  };

  // 폴링 중에 오너가 이 프로젝트를 삭제한 경우: 삭제 직전 화면이 멈춘 채로 보이는 대신
  // 안내를 띄우고(2.5초 뒤 자동으로, 또는 버튼으로 바로) 목록으로 돌려보낸다.
  if (projectDeleted) {
    return (
      <div>
        <TopBar onProjects={backToProjects} user={user} onSignOut={signOut} displayName={name} />
        <div style={{ minHeight: "60vh", display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
          <div style={{ textAlign: "center", maxWidth: 380 }}>
            <h1 style={{ fontSize: 22, fontWeight: 800, letterSpacing: "-.02em", margin: "0 0 10px" }}>이 프로젝트는 삭제되었습니다</h1>
            <p style={{ fontSize: 14.5, color: "#8a857f", margin: "0 0 24px", lineHeight: 1.6 }}>
              프로젝트 오너가 삭제했어요. 잠시 후 내 프로젝트 목록으로 이동합니다.
            </p>
            <button
              onClick={backToProjects}
              style={{ background: "#242322", color: "#fff", border: "none", borderRadius: 11, padding: "12px 22px", fontWeight: 700, fontSize: 14.5, cursor: "pointer" }}
            >
              지금 바로 이동
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ---- 화면 3: 보드 본체 ----
  return (
    <div>
      <TopBar
        onProjects={backToProjects}
        onCopyLink={copyBoardLink}
        linkCopied={boardLinkCopied}
        onSaveImage={downloadPhaseImage}
        onMinutes={() => setMinutesOpen(true)}
        minutesRecording={minutesRecording}
        user={user}
        onSignOut={signOut}
        dotColor={myColor.bg}
        myColor={myColor}
        onChangeColor={updateMyColor}
        displayName={name}
        onRenameNickname={updateNickname}
        right={
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            {/* "녹음 중" 배지 (시각 표시 전용). 누가 녹음 중인지 함께 보여준다 — 동시 녹음이 막히는
                이유를 배지만 보고도 알 수 있어야 하기 때문. 하트비트가 끊긴 죽은 점유는 표시하지 않는다. */}
            {recordingHeld && (
              <span style={{ display: "inline-flex", alignItems: "center", gap: 7, background: "#fdeaea", border: "1px solid #ffcaca", borderRadius: 999, padding: "6px 12px", fontSize: 12.5, fontWeight: 700, color: "#d32f2f" }}>
                <span style={{ width: 9, height: 9, borderRadius: 999, background: "#ff4242", animation: "oaRecPulse 1.1s ease-in-out infinite" }} />
                {micRecording || !board.recordingBy ? "녹음 중" : `${board.recordingBy}님 녹음 중`}
              </span>
            )}
          </div>
        }
      />
      <div style={{ maxWidth: 1120, margin: "0 auto", padding: "20px 24px 60px" }}>
        {/* 프로젝트 제목 + 참여자 수 */}
        <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 14, flexWrap: "wrap" }}>
          <span style={{ fontSize: 19, fontWeight: 800, letterSpacing: "-.02em" }}>{selectedProject.title}</span>
          <span style={{ fontSize: 13, color: "#8a857f" }}>참여자 {Object.keys(board.users).length}명</span>
        </div>
        {/* 탭바: 언더라인 스타일 */}
        <div
          style={{
            display: "flex",
            gap: 2,
            marginBottom: 22,
            borderBottom: "1px solid rgba(36,35,34,.09)",
            flexWrap: "wrap",
          }}
        >
          {[
            { key: "opinion", label: "의견 작성" },
            { key: "problem", label: "문제 정리" },
            { key: "voting", label: "우선순위 결과" },
            { key: "retro", label: "회고" },
            { key: "document", label: "문서" },
          ].map((tab) => {
            const on = activeTab === tab.key;
            return (
              <button
                key={tab.key}
                onClick={() => setActiveTab(tab.key)}
                style={{
                  padding: "13px 16px",
                  border: "none",
                  background: "none",
                  fontSize: 14,
                  fontWeight: 600,
                  cursor: "pointer",
                  color: on ? "#242322" : "#8a857f",
                  borderBottom: `2px solid ${on ? "#242322" : "transparent"}`,
                  marginBottom: -1,
                }}
              >
                {tab.label}
              </button>
            );
          })}
        </div>

        <div ref={phaseContentRef} style={{ position: "relative", background: "#ffffff" }}>
        <AnimatePresence mode="wait" initial={false}>
        {activeTab === "opinion" && (
          <motion.div key="opinion" {...fadeSlide}>
            {/* 안내 문구 배너: 왼쪽 STEP 라벨 + 편집 가능한 안내 문구 (글자 수에 맞춰 자동 높이) */}
            <div style={{ background: "#242322", borderRadius: 16, padding: "18px 22px", marginBottom: 12, display: "flex", alignItems: "flex-start", gap: 12 }}>
              <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: ".05em", color: "#a9e6d3", whiteSpace: "nowrap", paddingTop: 2, textAlign: "center", flexShrink: 0 }}>
                STEP 1<br />·<br />의견 작성
              </div>
              <textarea
                key={selectedProject.instructions}
                defaultValue={selectedProject.instructions}
                readOnly={!isOwner}
                title={isOwner ? "" : "이 안내 문구는 프로젝트 오너만 수정할 수 있어요"}
                ref={autoSizeRef}
                onInput={(e) => autoResizeTextarea(e.target)}
                onFocus={() => {
                  suspendPollRef.current = true;
                }}
                onBlur={(e) => {
                  suspendPollRef.current = false;
                  if (isOwner) updateInstructions(e.target.value);
                }}
                style={{
                  flex: 1,
                  background: "transparent",
                  border: "none",
                  outline: "none",
                  resize: "none",
                  overflow: "hidden",
                  cursor: isOwner ? "text" : "default",
                  color: "#e7e4df",
                  fontSize: 14.5,
                  lineHeight: 1.6,
                  boxSizing: "border-box",
                }}
              />
            </div>

            {/* 2번: 프로젝트 목표 한 줄 고정. goal이 없으면 영역 자체를 표시하지 않는다. */}
            {selectedProject.goal && (
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 18, fontSize: 14.5, fontWeight: 600, color: "#242322", background: "#fff", border: "1px solid rgba(36,35,34,.1)", borderLeft: "3px solid #eecd9c", borderRadius: 10, padding: "11px 16px" }}>
                <span style={{ flexShrink: 0 }}>🎯 목표 :</span>
                <input
                  key={selectedProject.goal}
                  defaultValue={selectedProject.goal}
                  onFocus={() => {
                    suspendPollRef.current = true;
                  }}
                  onBlur={(e) => {
                    suspendPollRef.current = false;
                    updateProjectGoal(e.target.value.trim() || selectedProject.goal);
                  }}
                  style={{ flex: 1, border: "none", background: "transparent", outline: "none", fontWeight: 500, color: "#57534e", minWidth: 0, fontSize: 14.5 }}
                />
              </div>
            )}

            {/* 참여자 색상 범례 (툴바) */}
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 16, alignItems: "center" }}>
              <span style={{ fontSize: 13, fontWeight: 700, color: "#8a857f", marginRight: 2, marginLeft: 4 }}>참여자</span>
              {Object.entries(board.users).map(([uname, u]) => (
                <span
                  key={uname}
                  style={{ display: "inline-flex", alignItems: "center", gap: 6, background: "#f2f2f2", borderRadius: 999, padding: "5px 12px 5px 7px", fontSize: 13, fontWeight: 600, color: "#242322" }}
                >
                  <span style={{ width: 16, height: 16, borderRadius: 999, background: u.color.bg, flexShrink: 0 }} />
                  {uname}
                </span>
              ))}
            </div>

            {/* 툴바: 투표 안내(좌) + 보드 추가/병합 모드(우) */}
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 16, flexWrap: "wrap" }}>
              <div data-guide="vote-status" style={{ fontSize: 13, color: "#8a857f" }}>
                투표: 남은 <b style={{ color: "#4f3fd6" }}>{Math.max(0, votesLeft)}</b> / {selectedProject.votesPerUser}표 · <span style={{ color: "#B52B1B", fontWeight: 700 }}>문제</span>로 표시된 포스트잇에 투표할 수 있어요
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <button
                  data-guide="merge"
                  onClick={() => {
                    setMergeMode((m) => !m);
                    setSelected([]);
                  }}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 7,
                    padding: "8px 14px",
                    borderRadius: 9,
                    border: `1px solid ${mergeMode ? "#bcd9ee" : "rgba(36,35,34,.14)"}`,
                    background: mergeMode ? "#eef4fb" : "#fff",
                    color: mergeMode ? "#0b57b8" : "#242322",
                    cursor: "pointer",
                    fontSize: 13,
                    fontWeight: 700,
                    whiteSpace: "nowrap",
                  }}
                >
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3" />
                  </svg>
                  {mergeMode ? "병합 모드 종료" : "병합 모드"}
                </button>
              </div>
            </div>

            {/* 병합 모드 안내 바 */}
            {mergeMode && (
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, background: "#eef4fb", border: "1px solid #bcd9ee", borderRadius: 10, padding: "10px 16px", marginBottom: 16 }}>
                <span style={{ fontSize: 13, fontWeight: 600, color: "#0b57b8" }}>
                  같은 보드 안에서 합칠 포스트잇을 2개 이상 선택하세요 · {selected.length}개 선택됨
                </span>
                {selected.length >= 2 && (
                  <button
                    onClick={mergeSelected}
                    style={{ background: "#0066ff", color: "#fff", border: "none", borderRadius: 8, padding: "8px 16px", fontSize: 13, fontWeight: 700, cursor: "pointer", whiteSpace: "nowrap" }}
                  >
                    선택 병합
                  </button>
                )}
              </div>
            )}

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
                    {...(topicIdx === 0 ? { "data-guide": "note-board" } : {})}
                    style={{
                      width: "100%",
                      background: "#fff",
                      border: "1px solid rgba(36,35,34,.08)",
                      borderRadius: 18,
                      padding: 20,
                      boxShadow: "0 1px 3px rgba(0,0,0,.04)",
                      boxSizing: "border-box",
                    }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16, gap: 8 }}>
                      <input
                        defaultValue={topic.title}
                        onBlur={(e) => renameTopic(topic.id, e.target.value.trim() || topic.title)}
                        style={{ fontSize: 17, fontWeight: 700, letterSpacing: "-.01em", color: "#242322", border: "none", background: "transparent", outline: "none", flex: 1, minWidth: 0 }}
                      />
                      <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                        {/* 3번: 보드 삭제 (마지막 1개는 삭제 불가) */}
                        {canDelete && (
                          <button
                            onClick={() => requestDeleteTopic(topic)}
                            title={problemNotes.length + plainNotes.length + parkedNotes.length === 0 ? "빈 보드 삭제" : "보드 삭제"}
                            style={{ border: "1px solid rgba(36,35,34,.1)", background: "#fff", color: "#a19c95", borderRadius: 9, padding: "7px 11px", cursor: "pointer", fontSize: 12.5, fontWeight: 600 }}
                          >
                            보드 삭제
                          </button>
                        )}
                        <button
                          data-guide="add-note"
                          onClick={() => createBlankNote(topic.id)}
                          style={{ padding: "7px 13px", borderRadius: 9, border: "1px dashed rgba(36,35,34,.22)", background: "#ffffff", color: "#57534e", fontWeight: 600, cursor: "pointer", fontSize: 13, whiteSpace: "nowrap" }}
                        >
                          + 포스트잇
                        </button>
                      </div>
                    </div>
                    <div
                      style={{
                        display: "flex",
                        flexDirection: "column",
                        gap: 14,
                        overflowX: "hidden",
                      }}
                    >
                      {/* 6번: 문제로 표시된 포스트잇을 보드 상단에 별도 구획(빨강 점선)으로 고정 */}
                      {problemNotes.length > 0 && (
                        <div style={{ border: "1px dashed #EA7A7A", borderRadius: 12, padding: "12px 12px 12px", background: "#FDF2EE" }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 14, fontWeight: 700, color: "#B5271B", marginBottom: 10, paddingLeft: 2 }}>
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                              <line x1="12" y1="9" x2="12" y2="13" />
                              <line x1="12" y1="17" x2="12.01" y2="17" />
                            </svg>
                            문제로 표시됨
                          </div>
                          <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
                            <AnimatePresence mode="popLayout">{problemNotes.map(renderNoteCard)}</AnimatePresence>
                          </div>
                        </div>
                      )}
                      {/* 5번: 일반 포스트잇은 flex-wrap으로 좌->우 채우고 줄바꿈 (가로 스크롤 없음).
                          포스트잇 옆 빈 공간(카드가 없는 gap 영역)을 클릭해도 새 포스트잇이 생기게 한다.
                          e.target === e.currentTarget로 카드 자체 클릭과 구분(카드를 눌렀을 때는 무시).
                          병합 모드에서는 카드를 골라 합치는 중이므로 빈 공간 클릭으로 새 포스트잇을 만들지 않는다. */}
                      {plainNotes.length > 0 && (
                        <div
                          onClick={(e) => {
                            if (!mergeMode && e.target === e.currentTarget) createBlankNote(topic.id);
                          }}
                          style={{ display: "flex", flexWrap: "wrap", gap: 12, minHeight: 30, cursor: mergeMode ? "default" : "pointer" }}
                        >
                          <AnimatePresence mode="popLayout">{plainNotes.map(renderNoteCard)}</AnimatePresence>
                        </div>
                      )}
                      {/* 1번: 보류된 포스트잇은 일반 포스트잇 아래에 별도 구획으로 고정 */}
                      {parkedNotes.length > 0 && (
                        <div style={{ border: "1px dashed rgba(36,35,34,.18)", borderRadius: 12, padding: "12px 12px 12px", background: "#ffffff" }}>
                          <div style={{ fontSize: 13, fontWeight: 700, color: "#8a857f", marginBottom: 10, paddingLeft: 2 }}>⏸ 보류된 의견</div>
                          <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
                            <AnimatePresence mode="popLayout">{parkedNotes.map(renderNoteCard)}</AnimatePresence>
                          </div>
                        </div>
                      )}
                      {topicNotes.length === 0 && (
                        <button
                          onClick={() => createBlankNote(topic.id)}
                          style={{
                            width: "100%",
                            background: "none",
                            border: "1.5px dashed rgba(36,35,34,.18)",
                            borderRadius: 12,
                            padding: 16,
                            fontSize: 13,
                            color: "#a19c95",
                            cursor: "pointer",
                            textAlign: "center",
                          }}
                        >
                          아직 포스트잇이 없습니다. 클릭해서 시작하세요.
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}

              {/* 시안처럼 의견 보드 추가 버튼을 보드 목록 맨 아래에 전체폭 점선 버튼으로 배치 */}
              <button
                onClick={addTopic}
                style={{
                  background: "none",
                  border: "1.5px dashed rgba(36,35,34,.2)",
                  borderRadius: 14,
                  padding: 16,
                  fontSize: 15,
                  fontWeight: 600,
                  color: "#8a857f",
                  cursor: "pointer",
                }}
              >
                + 새 의견 보드
              </button>
            </div>

            {/* 1번: 보류함. 원래 보드 자리에는 그대로 남기고(위 parkedNotes 구획에 포함), 전체 프로젝트 기준으로 모아 보여주는 접이식 섹션 */}
            <div style={{ marginTop: 22, background: "#fff", border: "1px solid rgba(36,35,34,.08)", borderRadius: 14, overflow: "hidden" }}>
              <button
                onClick={() => setParkingOpen((v) => !v)}
                style={{
                  width: "100%",
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  padding: "15px 20px",
                  border: "none",
                  background: "none",
                  color: "#242322",
                  fontSize: 15,
                  fontWeight: 700,
                  cursor: "pointer",
                }}
              >
                <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  📥 보류함
                  <span style={{ background: "#eeeeee", color: "#8a857f", borderRadius: 999, padding: "1px 9px", fontSize: 12, fontWeight: 700 }}>{parkedNotesAll.length}</span>
                </span>
                <span style={{ fontSize: 13, color: "#8a857f", transform: parkingOpen ? "rotate(180deg)" : "rotate(0)", transition: "transform .15s" }}>▾</span>
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
                    borderTop: "1px solid rgba(36,35,34,.07)",
                    overflow: "hidden",
                  }}
                >
                  <div style={{ padding: "14px 20px 18px", display: "flex", flexDirection: "column", gap: 8 }}>
                  {parkedNotesAll.length === 0 && (
                    <div style={{ color: "#a19c95", fontSize: 13, padding: "16px 0", textAlign: "center" }}>보류한 의견이 없습니다.</div>
                  )}
                  <AnimatePresence mode="popLayout">
                  {parkedNotesAll.map((n) => {
                    const topicTitle = board.topics.find((t) => t.id === n.topicId)?.title || "";
                    const nColor = board.users[n.authors[0]]?.color || PALETTE[0];
                    return (
                      <motion.div
                        key={n.id}
                        {...popIn}
                        style={{
                          display: "flex",
                          flexDirection: "column",
                          gap: 6,
                          padding: "10px 14px",
                          borderRadius: 10,
                          background: "#f7f7f7",
                        }}
                      >
                        <div
                          onClick={() => scrollToTopic(n.topicId)}
                          title="원래 의견 보드로 이동"
                          style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, cursor: "pointer" }}
                        >
                          <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0, flex: 1 }}>
                            <span style={{ width: 12, height: 12, borderRadius: 999, flexShrink: 0, background: nColor.bg }} />
                            <span style={{ fontSize: 14.5, color: "#57534e", wordBreak: "break-word", flex: 1 }}>
                              {n.text || <span style={{ color: "#a19c95" }}>(빈 포스트잇)</span>}
                            </span>
                            <span style={{ fontSize: 13, color: "#a19c95", flexShrink: 0 }}>{topicTitle}</span>
                          </div>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              toggleParked(n.id);
                            }}
                            style={{
                              border: "1px solid rgba(36,35,34,.12)",
                              background: "#fff",
                              color: "#242322",
                              borderRadius: 7,
                              fontSize: 13,
                              fontWeight: 600,
                              padding: "6px 11px",
                              cursor: "pointer",
                              flexShrink: 0,
                              whiteSpace: "nowrap",
                            }}
                          >
                            의견으로 되돌리기
                          </button>
                        </div>
                        {/* 보류된 이유: "문제" 설명과 동일하게 note.description을 재사용 */}
                        <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
                          <span style={{ fontSize: 12, color: "#a19c95", flexShrink: 0, marginTop: 6 }}>이유 :</span>
                          <textarea
                            value={n.description || ""}
                            ref={autoSizeRef}
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

        {activeTab === "problem" && (
          <motion.div key="problem" {...fadeSlide}>
            {/* STEP 2 배너 */}
            <div style={{ background: "#242322", borderRadius: 16, padding: "18px 22px", marginBottom: 20, display: "flex", alignItems: "flex-start", gap: 12 }}>
              <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: ".05em", color: "#bcd9ee", whiteSpace: "nowrap", paddingTop: 2, textAlign: "center", flexShrink: 0 }}>
                STEP 2<br />·<br />문제 정리
              </div>
              <p style={{ margin: 0, fontSize: 14, lineHeight: 1.6, color: "#e7e4df" }}>
                여러 보드에서 <b style={{ color: "#fff" }}>"문제로"</b> 표시한 의견을 한곳에 모았습니다. 문구를 다듬고, 필요하면 배경 설명을 덧붙이세요.
                <br />다음 단계에서 이 목록으로 투표합니다.
              </p>
            </div>
            {problemNotesAll.length === 0 && (
              <div style={{ textAlign: "center", padding: "60px 20px", color: "#a19c95", fontSize: 14 }}>
                아직 문제로 표시된 의견이 없습니다.
                <br />의견 작성 탭에서 "문제로"를 눌러 추가하세요.
              </div>
            )}
            <div {...(problemNotesAll.length > 0 && { "data-guide": "problem-area" })} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {problemNotesSorted.map((n, i) => {
                const topicTitle = board.topics.find((t) => t.id === n.topicId)?.title || "";
                return (
                  <div key={n.id} style={{ background: "#fff", border: "1px solid rgba(36,35,34,.09)", borderRadius: 14, padding: "18px 20px", boxShadow: "0 1px 3px rgba(0,0,0,.04)", display: "flex", gap: 16 }}>
                    <span style={{ width: 30, height: 30, borderRadius: 8, color: "#1B65B5", fontWeight: 800, fontSize: 14, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, background: "#EEF0FD" }}>
                      {i + 1}
                    </span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 9, flexWrap: "wrap" }}>
                        <span style={{ display: "inline-flex", alignItems: "center", gap: 5, background: "#f2f2f2", borderRadius: 999, padding: "3px 10px", fontSize: 13, fontWeight: 600, color: "#8a857f" }}>
                          원본 : {topicTitle}
                        </span>
                        <button
                          onClick={() => toggleProblem(n.id)}
                          title="문제 표시 해제 (포스트잇은 유지)"
                          style={{ border: "1px solid rgba(36,35,34,.1)", background: "#fff", color: "#a19c95", borderRadius: 7, fontSize: 12, fontWeight: 600, padding: "3px 9px", cursor: "pointer", marginLeft: "auto" }}
                        >
                          문제 해제
                        </button>
                      </div>
                      <textarea
                        value={n.text}
                        ref={autoSizeRef}
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
                        placeholder="문제 문구 — 무엇이 문제인가요? (원본 포스트잇과 연동)"
                        style={{ width: "100%", border: "none", borderBottom: "1px solid transparent", resize: "none", overflow: "hidden", fontSize: 16.5, fontWeight: 700, color: "#242322", outline: "none", padding: "2px 0 6px", boxSizing: "border-box", lineHeight: 1.4 }}
                      />
                      <textarea
                        value={n.description || ""}
                        ref={autoSizeRef}
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
                        placeholder="부가 설명 추가 (선택) — 왜 문제인지, 어떤 상황인지"
                        style={{ width: "100%", border: "none", resize: "none", overflow: "hidden", fontSize: 14, color: "#6f6b66", outline: "none", padding: "6px 0 0", boxSizing: "border-box", lineHeight: 1.5 }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </motion.div>
        )}

        {activeTab === "voting" && (
          <motion.div key="voting" {...fadeSlide}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 20, flexWrap: "wrap", gap: 16 }}>
              <div>
                <h2 style={{ fontSize: 22, fontWeight: 800, letterSpacing: "-.02em", margin: "0 0 4px" }}>우선순위 결과</h2>
                <p style={{ fontSize: 13.5, color: "#8a857f", margin: 0 }}>
                  득표순 정렬 · 내 남은 투표권 <b style={{ color: "#4f3fd6" }}>{Math.max(0, votesLeft)}</b>표
                </p>
              </div>
              {/* 1인당 투표권 조정: 오너만 +/- 컨트롤이 보이고, 팀원에게는 조정 UI 자체를 숨긴 채 값만 안내한다 */}
              {isOwner ? (
                <div style={{ display: "flex", alignItems: "center", gap: 10, background: "#fff", border: "1px solid rgba(36,35,34,.1)", borderRadius: 10, padding: "8px 12px" }}>
                  <span style={{ fontSize: 13, fontWeight: 600, color: "#57534e" }}>1인당 투표권</span>
                  <button
                    onClick={() => setVotesPerUser(Math.max(1, selectedProject.votesPerUser - 1))}
                    style={{ width: 26, height: 26, borderRadius: 7, border: "1px solid rgba(36,35,34,.14)", background: "#fff", fontSize: 16, fontWeight: 700, cursor: "pointer", lineHeight: 1, color: "#242322" }}
                  >
                    −
                  </button>
                  <span style={{ fontWeight: 800, fontSize: 15, minWidth: 16, textAlign: "center" }}>{selectedProject.votesPerUser}</span>
                  <button
                    onClick={() => setVotesPerUser(Math.min(10, selectedProject.votesPerUser + 1))}
                    style={{ width: 26, height: 26, borderRadius: 7, border: "1px solid rgba(36,35,34,.14)", background: "#fff", fontSize: 16, fontWeight: 700, cursor: "pointer", lineHeight: 1, color: "#242322" }}
                  >
                    +
                  </button>
                </div>
              ) : (
                <div style={{ fontSize: 13, fontWeight: 600, color: "#57534e", background: "#fff", border: "1px solid rgba(36,35,34,.1)", borderRadius: 10, padding: "8px 12px" }}>
                  1인당 투표권 {selectedProject.votesPerUser}표
                </div>
              )}
            </div>
            {rankedProblems.length === 0 && (
              <div style={{ textAlign: "center", padding: "60px 20px", color: "#a19c95", fontSize: 14 }}>
                투표할 문제가 없습니다. 먼저 의견 작성 탭에서 "문제로" 표시하고 투표하세요.
              </div>
            )}
            {(() => {
              const maxV = Math.max(1, ...rankedProblems.map((p) => (board.votes[p.id] || []).length));
              return (
                <div data-guide="vote-area" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  {rankedProblems.map((p, i) => {
                    const voters = board.votes[p.id] || [];
                    const first = i === 0 && voters.length > 0;
                    // 디자인(Onalign.dc.html) 반영: 카드마다 투표 토글 버튼.
                    // 투표함 -> 어두운색(취소 가능), 투표 안 함 & 투표권 남음 -> 보라색, 투표권 소진 -> 비활성 회색.
                    const iVoted = voters.includes(name);
                    const canVote = votesLeft > 0;
                    const voteDisabled = !iVoted && !canVote;
                    const voteBtnBg = iVoted ? "#242322" : canVote ? "#5b4dde" : "#f0ede8";
                    const voteBtnFg = iVoted ? "#fff" : canVote ? "#fff" : "#b0aba4";
                    const voteBtnBorder = iVoted ? "#242322" : canVote ? "#5b4dde" : "rgba(36,35,34,.08)";
                    return (
                      <div
                        key={p.id}
                        style={{
                          background: first ? "#f5f3fe" : "#fff",
                          border: `1px solid ${first ? "#a99bf2" : "rgba(36,35,34,.09)"}`,
                          borderRadius: 14,
                          padding: "18px 20px",
                          boxShadow: first ? "0 4px 14px rgba(120,95,235,.25)" : "0 1px 3px rgba(0,0,0,.04)",
                          display: "flex",
                          alignItems: "center",
                          gap: 18,
                        }}
                      >
                        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", width: 44, flexShrink: 0 }}>
                          {first && <span style={{ fontSize: 11, fontWeight: 700, color: "#4f3fd6" }}>1위</span>}
                          <span style={{ fontSize: 28, fontWeight: 800, lineHeight: 1, color: first ? "#4f3fd6" : "#bcbcbc" }}>{i + 1}</span>
                        </div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 16.5, fontWeight: 700, letterSpacing: "-.01em", marginBottom: p.description ? 4 : 8 }}>{p.text}</div>
                          {p.description && <div style={{ fontSize: 14, color: "#8a857f", marginBottom: 9 }}>{p.description}</div>}
                          <div style={{ height: 8, background: "#eeeeee", borderRadius: 999, overflow: "hidden", marginBottom: 9 }}>
                            <div style={{ height: "100%", borderRadius: 999, background: first ? "#8a7cf0" : "#c4c4c4", width: `${Math.round((voters.length / maxV) * 100)}%` }} />
                          </div>
                          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                            <div style={{ display: "flex" }}>
                              {voters.map((v) => {
                                const c = board.users[v]?.color || PALETTE[0];
                                return <span key={v} title={v} style={{ width: 18, height: 18, borderRadius: 999, border: "2px solid #fff", marginLeft: -5, background: c.bg, display: "inline-block" }} />;
                              })}
                            </div>
                            <span style={{ fontSize: 12.5, color: "#8a857f", fontWeight: 600 }}>{voters.length}표</span>
                          </div>
                        </div>
                        <button
                          onClick={() => toggleVote(p.id)}
                          disabled={voteDisabled}
                          title={voteDisabled ? "투표권을 모두 사용했습니다" : iVoted ? "투표 취소" : "투표"}
                          style={{
                            background: voteBtnBg,
                            color: voteBtnFg,
                            border: `1px solid ${voteBtnBorder}`,
                            borderRadius: 9,
                            padding: "9px 15px",
                            fontSize: 13,
                            fontWeight: 700,
                            cursor: voteDisabled ? "not-allowed" : "pointer",
                            whiteSpace: "nowrap",
                            flexShrink: 0,
                          }}
                        >
                          {iVoted ? "투표 취소" : "투표"}
                        </button>
                      </div>
                    );
                  })}
                </div>
              );
            })()}
          </motion.div>
        )}

        {activeTab === "retro" && (
          <motion.div key="retro" {...fadeSlide}>
            {/* STEP 5 배너 */}
            <div style={{ background: "#242322", borderRadius: 16, padding: "18px 22px", marginBottom: 20, display: "flex", alignItems: "flex-start", gap: 12 }}>
              <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: ".05em", color: "#d6c9ee", whiteSpace: "nowrap", paddingTop: 2, textAlign: "center", flexShrink: 0 }}>
                STEP 5<br />·<br />회고
              </div>
              <p style={{ margin: 0, fontSize: 14, lineHeight: 1.6, color: "#e7e4df" }}>
                각자 <b style={{ color: "#fff" }}>Keep · Problem · Try</b>를 적고 "완료"를 눌러 주세요. 완료한 사람의 회고만 문서에 반영됩니다.
                <br />완료 후에도 자유롭게 수정할 수 있고, 수정하면 문서에도 자동으로 갱신됩니다.
              </p>
            </div>

            {/* 우선순위 해결여부 점검 토글 (누구나 켜고 끌 수 있음, 기본 ON) */}
            <div data-guide="retro-priority" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, background: "#fff", border: "1px solid rgba(36,35,34,.1)", borderRadius: 12, padding: "14px 18px", marginBottom: 16, flexWrap: "wrap" }}>
              <div>
                <div style={{ fontSize: 15, fontWeight: 700 }}>우선순위 해결여부 점검</div>
                <div style={{ fontSize: 13, color: "#8a857f", marginTop: 2 }}>우선순위 결과에서 정한 문제들이 이번에 해결됐는지 함께 확인합니다.</div>
              </div>
              <button
                onClick={toggleRetroPriorityCheck}
                role="switch"
                aria-checked={board.retroPriorityCheck !== false}
                title="우선순위 해결여부 섹션 표시/숨김"
                style={{
                  width: 46,
                  height: 26,
                  borderRadius: 999,
                  border: "none",
                  cursor: "pointer",
                  flexShrink: 0,
                  background: board.retroPriorityCheck !== false ? "#5b4dde" : "#d5d1cb",
                  position: "relative",
                  padding: 0,
                }}
              >
                <span style={{ position: "absolute", top: 3, left: board.retroPriorityCheck !== false ? 23 : 3, width: 20, height: 20, borderRadius: 999, background: "#fff", transition: "left .15s ease", boxShadow: "0 1px 3px rgba(0,0,0,.25)" }} />
              </button>
            </div>

            {/* 우선순위 해결여부 목록 (ON일 때만, KPT 칸 위쪽) */}
            {board.retroPriorityCheck !== false && (
              <div style={{ marginBottom: 22 }}>
                {rankedProblems.length === 0 ? (
                  <div style={{ background: "#fff", border: "1px solid rgba(36,35,34,.09)", borderRadius: 12, padding: "16px 18px", color: "#a19c95", fontSize: 13.5 }}>
                    우선순위로 정리된 문제가 없습니다. "문제 정리 → 우선순위 결과"에서 먼저 진행하세요.
                  </div>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    {rankedProblems.map((p, i) => {
                      const cur = board.priorityResolution?.[p.id] || "";
                      return (
                        <div key={p.id} style={{ background: "#fff", border: "1px solid rgba(36,35,34,.09)", borderRadius: 12, padding: "14px 16px", display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                          <span style={{ fontSize: 15, fontWeight: 800, color: "#bcbcbc", width: 22, flexShrink: 0, textAlign: "center" }}>{i + 1}</span>
                          <span style={{ flex: 1, minWidth: 140, fontSize: 14.5, fontWeight: 600 }}>{p.text}</span>
                          <div style={{ display: "inline-flex", background: "#f2f0ec", borderRadius: 9, padding: 3, gap: 2, flexShrink: 0 }}>
                            {[
                              ["resolved", "해결됨", "#1e7a4d"],
                              ["partial", "부분해결", "#9a6a15"],
                              ["unresolved", "미해결", "#c0392b"],
                            ].map(([val, label, activeColor]) => {
                              const on = cur === val;
                              return (
                                <button
                                  key={val}
                                  onClick={() => setPriorityResolution(p.id, val)}
                                  style={{
                                    border: "none",
                                    borderRadius: 7,
                                    padding: "6px 12px",
                                    fontSize: 12.5,
                                    fontWeight: 700,
                                    cursor: "pointer",
                                    background: on ? "#fff" : "transparent",
                                    color: on ? activeColor : "#8a857f",
                                    boxShadow: on ? "0 1px 2px rgba(0,0,0,.12)" : "none",
                                  }}
                                >
                                  {label}
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {/* 참여자별 KPT 입력 칸 (참여자 수만큼, 본인 칸만 편집 가능) */}
            <div data-guide="retro-kpt" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 14 }}>
              {Object.entries(board.users).length === 0 ? (
                <div style={{ color: "#a19c95", fontSize: 14 }}>참여자가 없습니다.</div>
              ) : (
                Object.entries(board.users).map(([owner, u]) => {
                  const mineCell = owner === name;
                  const r = board.retros?.[owner] || {};
                  const done = !!r.done;
                  const col = u.color || PALETTE[0];
                  const kptField = (field, label, placeholder) => (
                    <div style={{ marginBottom: 10 }}>
                      <div style={{ fontSize: 12, fontWeight: 700, color: "#8a857f", marginBottom: 4 }}>{label}</div>
                      <textarea
                        value={r[field] || ""}
                        readOnly={!mineCell}
                        ref={autoSizeRef}
                        onInput={(e) => autoResizeTextarea(e.target)}
                        onChange={mineCell ? (e) => { editRetroLocal(owner, field, e.target.value); autoResizeTextarea(e.target); } : undefined}
                        onFocus={mineCell ? () => { suspendPollRef.current = true; } : undefined}
                        onBlur={mineCell ? () => { suspendPollRef.current = false; commitRetro(owner); } : undefined}
                        placeholder={mineCell ? placeholder : "—"}
                        style={{ width: "100%", boxSizing: "border-box", border: "1px solid rgba(36,35,34,.12)", borderRadius: 8, padding: "8px 10px", resize: "none", overflow: "hidden", fontSize: 13.5, fontFamily: "inherit", lineHeight: 1.5, outline: "none", minHeight: 34, background: mineCell ? "#fff" : "#faf9f7", color: "#242322" }}
                      />
                    </div>
                  );
                  return (
                    <div key={owner} style={{ background: "#fff", border: `1px solid ${done ? "rgba(114,201,172,.6)" : "rgba(36,35,34,.09)"}`, borderRadius: 14, padding: "16px 18px", boxShadow: "0 1px 3px rgba(0,0,0,.04)", display: "flex", flexDirection: "column" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
                        <span style={{ width: 15, height: 15, borderRadius: 999, background: col.bg, flexShrink: 0 }} />
                        <span style={{ fontSize: 14.5, fontWeight: 700 }}>{owner}</span>
                        {mineCell && <span style={{ fontSize: 11, color: "#8a857f" }}>(나)</span>}
                        {done && (
                          <span style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 4, background: "#e6f7f1", color: "#1e7a4d", border: "1px solid #a9e6d3", borderRadius: 999, padding: "3px 9px", fontSize: 11.5, fontWeight: 700 }}>
                            ✓ 완료
                          </span>
                        )}
                      </div>
                      {kptField("keep", "Keep — 잘된 점", "계속 유지하고 싶은 점")}
                      {kptField("problem", "Problem — 아쉬운 점", "문제였던 점")}
                      {kptField("try", "Try — 시도할 점", "다음에 시도해볼 점")}
                      {mineCell && (
                        <button
                          onClick={() => toggleRetroDone(owner)}
                          style={{ marginTop: 4, alignSelf: "flex-end", padding: "8px 16px", borderRadius: 8, border: done ? "1px solid rgba(36,35,34,.14)" : "none", background: done ? "#fff" : "#242322", color: done ? "#242322" : "#fff", cursor: "pointer", fontSize: 13, fontWeight: 700 }}
                        >
                          {done ? "완료 취소" : "완료"}
                        </button>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </motion.div>
        )}

        {activeTab === "document" && (
          <motion.div key="document" {...fadeSlide}>
            {/* 토글(과정/결과)과 다운로드 버튼 그룹을 좌우로 나란히 두지 않고 항상 세로로 쌓는다.
                좌우 배치는 좁은 화면에서 토글이 혼자 줄바꿈되어 어색해 보이는 문제가 있어,
                각 그룹이 항상 전체 너비를 쓰도록 고정한다. */}
            <div style={{ display: "flex", flexDirection: "column", gap: 12, marginBottom: 20 }}>
              {/* 세그먼트 토글 (과정 / 결과) */}
              <div style={{ display: "inline-flex", alignSelf: "flex-start", borderRadius: 11, padding: 4, background: "#eeeeee" }}>
                <button
                  data-guide="doc-type-process"
                  onClick={() => {
                    setDocType("process");
                    setPromptDraft(null); // 문서 종류가 바뀌면 프롬프트 본문도 달라지므로 직접 수정분은 버린다
                  }}
                  style={{
                    border: "none",
                    borderRadius: 8,
                    padding: "9px 20px",
                    fontSize: 14,
                    fontWeight: 700,
                    cursor: "pointer",
                    background: docType === "process" ? "#fff" : "transparent",
                    color: docType === "process" ? "#242322" : "#8a857f",
                    boxShadow: docType === "process" ? "0 1px 2px rgba(0,0,0,.1)" : "none",
                  }}
                >
                  과정 문서
                </button>
                <button
                  data-guide="doc-type-result"
                  onClick={() => {
                    setDocType("result");
                    setPromptDraft(null); // 문서 종류가 바뀌면 프롬프트 본문도 달라지므로 직접 수정분은 버린다
                  }}
                  style={{
                    border: "none",
                    borderRadius: 8,
                    padding: "9px 20px",
                    fontSize: 14,
                    fontWeight: 700,
                    cursor: "pointer",
                    background: docType === "result" ? "#fff" : "transparent",
                    color: docType === "result" ? "#242322" : "#8a857f",
                    boxShadow: docType === "result" ? "0 1px 2px rgba(0,0,0,.1)" : "none",
                  }}
                >
                  결과 문서
                </button>
              </div>
              <div>
                {/* 버튼 4개를 2개씩 짝지어, 화면이 좁아 줄바꿈될 때 낱개가 아니라 짝(그룹) 단위로 줄바꿈되게 한다.
                    "프롬프트 추출" 혼자 다음 줄에 덜렁 남는 걸 막기 위해 "마크다운으로 다운로드"와 한 그룹으로 묶는다. */}
                <div data-guide="doc-download" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
                    <button
                      onClick={downloadDocImage}
                      style={{ padding: "9px 14px", borderRadius: 9, border: "none", background: "#353433", color: "#fff", cursor: "pointer", fontSize: 13, fontWeight: 600, whiteSpace: "nowrap" }}
                    >
                      이미지로 저장
                    </button>
                    {/* docx·마크다운·프롬프트는 현재 보드에서 다시 계산하므로, 고정된 문서를 보는 중에는
                        막는다(화면은 과거인데 파일은 현재 내용으로 나오는 걸 방지). 이미지·PDF는 화면을
                        그대로 캡처하는 방식이라 스냅샷을 봐도 보이는 그대로 저장돼 그냥 열어둔다. */}
                    <button
                      onClick={() => downloadDoc(docType)}
                      disabled={docxDownloading || docReadOnly}
                      title={docReadOnly ? "고정된 문서는 이미지·PDF로만 저장할 수 있습니다" : ""}
                      style={{ padding: "9px 14px", borderRadius: 9, border: "1px solid rgba(36,35,34,.14)", background: "#fff", color: docReadOnly ? "#c4bfb8" : "#242322", cursor: docxDownloading ? "wait" : docReadOnly ? "not-allowed" : "pointer", fontSize: 13, fontWeight: 600, whiteSpace: "nowrap", opacity: docxDownloading ? 0.6 : 1 }}
                    >
                      {docxDownloading ? "생성 중..." : "docx로 다운로드"}
                    </button>
                  </div>
                  <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
                    <button
                      onClick={downloadDocPdf}
                      disabled={pdfDownloading}
                      title="현재 문서 화면을 그대로 PDF로 저장합니다"
                      style={{ padding: "9px 14px", borderRadius: 9, border: "1px solid rgba(36,35,34,.14)", background: "#fff", color: "#242322", cursor: pdfDownloading ? "wait" : "pointer", fontSize: 13, fontWeight: 600, whiteSpace: "nowrap", opacity: pdfDownloading ? 0.6 : 1 }}
                    >
                      {pdfDownloading ? "생성 중..." : "PDF로 다운로드"}
                    </button>
                    <button
                      onClick={() => downloadDocMarkdown(docType)}
                      disabled={docReadOnly}
                      title={docReadOnly ? "고정된 문서는 이미지·PDF로만 저장할 수 있습니다" : ""}
                      style={{ padding: "9px 14px", borderRadius: 9, border: "1px solid rgba(36,35,34,.14)", background: "#fff", color: docReadOnly ? "#c4bfb8" : "#242322", cursor: docReadOnly ? "not-allowed" : "pointer", fontSize: 13, fontWeight: 600, whiteSpace: "nowrap" }}
                    >
                      마크다운으로 다운로드
                    </button>
                    <button
                      onClick={() => setPromptOpen((v) => !v)}
                      disabled={docReadOnly}
                      title={docReadOnly ? "고정된 문서에서는 프롬프트를 추출할 수 없습니다" : "지시문 종류와 포함 항목을 고른 뒤 프롬프트를 복사합니다"}
                      style={{ padding: "9px 14px", borderRadius: 9, border: `1px solid ${promptOpen ? "#242322" : "rgba(36,35,34,.14)"}`, background: promptOpen ? "#242322" : "#fff", color: docReadOnly ? "#c4bfb8" : promptOpen ? "#fff" : "#242322", cursor: docReadOnly ? "not-allowed" : "pointer", fontSize: 13, fontWeight: 600, whiteSpace: "nowrap" }}
                    >
                      프롬프트 추출{promptOpen ? " 닫기" : ""}
                    </button>
                  </div>
                  <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
                    <button
                      onClick={saveSnapshot}
                      disabled={docReadOnly}
                      title={docReadOnly ? "현재 문서로 돌아간 뒤에 고정할 수 있습니다" : "지금 문서 내용을 그대로 저장해둡니다. 이후 의견이나 회고가 바뀌어도 저장된 내용은 그대로 남습니다."}
                      style={{ padding: "9px 14px", borderRadius: 9, border: "1px solid rgba(36,35,34,.14)", background: "#fff", color: docReadOnly ? "#c4bfb8" : "#242322", cursor: docReadOnly ? "not-allowed" : "pointer", fontSize: 13, fontWeight: 600, whiteSpace: "nowrap" }}
                    >
                      현재 시점으로 고정
                    </button>
                    {(board.snapshots || []).length > 0 && (
                      <button
                        onClick={() => setSnapshotListOpen((v) => !v)}
                        style={{ padding: "9px 14px", borderRadius: 9, border: `1px solid ${snapshotListOpen ? "#242322" : "rgba(36,35,34,.14)"}`, background: snapshotListOpen ? "#242322" : "#fff", color: snapshotListOpen ? "#fff" : "#242322", cursor: "pointer", fontSize: 13, fontWeight: 600, whiteSpace: "nowrap" }}
                      >
                        고정된 문서 {board.snapshots.length}개
                      </button>
                    )}
                  </div>
                </div>
                <div style={{ fontSize: 12, color: "#a19c95", marginTop: 8, textAlign: "left" }}>
                  회의 녹취록과 문서 내용을 하나의 프롬프트로 만들어드립니다. 복사해서 ChatGPT·Claude·Gemini 등 사용하시는 AI에 붙여넣으면 정리된 문서를 받아볼 수 있습니다.
                </div>

                {/* 고정된 문서 목록 */}
                <AnimatePresence>
                  {snapshotListOpen && (board.snapshots || []).length > 0 && (
                    <motion.div
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: "auto" }}
                      exit={{ opacity: 0, height: 0 }}
                      transition={{ duration: 0.18, ease: EASE }}
                      style={{ overflow: "hidden", textAlign: "left" }}
                    >
                      <div style={{ marginTop: 14, border: "1px solid rgba(36,35,34,.12)", borderRadius: 12, padding: 14, background: "#faf9f7", display: "flex", flexDirection: "column", gap: 8 }}>
                        {[...board.snapshots]
                          .sort((a, b) => b.at - a.at) // 최근에 고정한 것부터
                          .map((s) => {
                            const on = viewingSnapshotId === s.id;
                            return (
                              <div key={s.id} style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", background: "#fff", border: `1px solid ${on ? "#a99bf2" : "rgba(36,35,34,.09)"}`, borderRadius: 9, padding: "9px 12px" }}>
                                <span style={{ fontSize: 13, fontWeight: 700, color: "#242322" }}>
                                  {new Date(s.at).toLocaleString("ko-KR")}
                                </span>
                                <span style={{ fontSize: 11.5, color: "#8a857f", background: "#f2f2f2", borderRadius: 6, padding: "2px 7px", fontWeight: 600 }}>
                                  {s.docType === "result" ? "결과" : "과정"}
                                </span>
                                {s.by && <span style={{ fontSize: 12, color: "#8a857f" }}>{s.by}</span>}
                                <button
                                  onClick={() => setViewingSnapshotId(on ? null : s.id)}
                                  style={{ marginLeft: "auto", padding: "6px 12px", borderRadius: 8, border: "1px solid rgba(36,35,34,.14)", background: on ? "#242322" : "#fff", color: on ? "#fff" : "#242322", cursor: "pointer", fontSize: 12.5, fontWeight: 600, whiteSpace: "nowrap" }}
                                >
                                  {on ? "닫기" : "열어보기"}
                                </button>
                                <button
                                  onClick={() =>
                                    setConfirmState({
                                      title: "고정된 문서를 삭제할까요?",
                                      message: `${new Date(s.at).toLocaleString("ko-KR")}에 고정한 문서를 삭제합니다. 되돌릴 수 없습니다.`,
                                      confirmLabel: "삭제",
                                      onConfirm: () => {
                                        if (viewingSnapshotId === s.id) setViewingSnapshotId(null);
                                        deleteSnapshot(s.id);
                                        setConfirmState(null);
                                      },
                                    })
                                  }
                                  title="삭제"
                                  style={{ padding: "6px 10px", borderRadius: 8, border: "none", background: "none", color: "#a19c95", cursor: "pointer", fontSize: 12.5, fontWeight: 600 }}
                                >
                                  삭제
                                </button>
                              </div>
                            );
                          })}
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>

                {/* 프롬프트 추출 옵션 패널: 지시문 프리셋 + 포함 항목 + 글자 수 + 미리보기(수정 가능) */}
                <AnimatePresence>
                  {promptOpen && (
                    <motion.div
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: "auto" }}
                      exit={{ opacity: 0, height: 0 }}
                      transition={{ duration: 0.18, ease: EASE }}
                      style={{ overflow: "hidden", textAlign: "left" }}
                    >
                      <div style={{ marginTop: 14, border: "1px solid rgba(36,35,34,.12)", borderRadius: 12, padding: 16, background: "#faf9f7" }}>
                        <div style={{ fontSize: 12, fontWeight: 700, color: "#57534e", marginBottom: 9 }}>어떤 형태로 받을까요?</div>
                        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 16 }}>
                          {PROMPT_PRESETS.map((p) => {
                            const on = promptPreset === p.key;
                            return (
                              <button
                                key={p.key}
                                onClick={() => {
                                  setPromptPreset(p.key);
                                  setPromptDraft(null); // 프리셋을 바꾸면 직접 수정한 내용은 버리고 새로 생성
                                }}
                                title={p.hint}
                                style={{
                                  padding: "9px 13px",
                                  borderRadius: 9,
                                  border: `1px solid ${on ? "#242322" : "rgba(36,35,34,.14)"}`,
                                  background: on ? "#242322" : "#fff",
                                  color: on ? "#fff" : "#57534e",
                                  cursor: "pointer",
                                  fontSize: 13,
                                  fontWeight: 600,
                                  whiteSpace: "nowrap",
                                }}
                              >
                                {p.label}
                              </button>
                            );
                          })}
                        </div>

                        <div style={{ fontSize: 12, fontWeight: 700, color: "#57534e", marginBottom: 9 }}>포함할 내용</div>
                        <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginBottom: 14 }}>
                          {[
                            ["withFields", "문서 표준 4필드"],
                            ["withRetros", "완료된 회고"],
                            ["withMinutes", "회의 녹취록"],
                          ].map(([key, label]) => (
                            <label key={key} style={{ display: "inline-flex", alignItems: "center", gap: 7, fontSize: 13, color: "#242322", cursor: "pointer", fontWeight: 500 }}>
                              <input
                                type="checkbox"
                                checked={promptInclude[key]}
                                onChange={(e) => {
                                  setPromptInclude((prev) => ({ ...prev, [key]: e.target.checked }));
                                  setPromptDraft(null); // 포함 항목이 바뀌면 미리보기를 새로 생성
                                }}
                                style={{ width: 15, height: 15, accentColor: "#5b4dde", cursor: "pointer" }}
                              />
                              {label}
                            </label>
                          ))}
                        </div>
                        <div style={{ fontSize: 11.5, color: "#a19c95", marginBottom: 14, lineHeight: 1.5 }}>
                          {docType === "result" ? "우선순위 TOP과 해결여부는" : "의견 모음과 문제 정리는"} 문서 종류에 따라 항상 포함됩니다.
                        </div>

                        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: 7, flexWrap: "wrap" }}>
                          <div style={{ fontSize: 12, fontWeight: 700, color: "#57534e" }}>미리보기 (직접 고쳐서 복사할 수 있어요)</div>
                          <div style={{ fontSize: 11.5, color: "#8a857f", fontWeight: 600 }}>약 {promptText.length.toLocaleString("ko-KR")}자</div>
                        </div>
                        <textarea
                          value={promptText}
                          onChange={(e) => setPromptDraft(e.target.value)}
                          onFocus={() => {
                            suspendPollRef.current = true;
                          }}
                          onBlur={() => {
                            suspendPollRef.current = false;
                          }}
                          spellCheck={false}
                          style={{
                            width: "100%",
                            boxSizing: "border-box",
                            height: 190,
                            resize: "vertical",
                            border: "1px solid rgba(36,35,34,.14)",
                            borderRadius: 9,
                            padding: "11px 13px",
                            fontSize: 12.5,
                            lineHeight: 1.65,
                            fontFamily: "inherit",
                            color: "#242322",
                            background: "#fff",
                            outline: "none",
                          }}
                        />
                        <div style={{ display: "flex", gap: 8, marginTop: 11, flexWrap: "wrap", alignItems: "center" }}>
                          <button
                            onClick={() => copyDocPrompt(promptText)}
                            style={{ padding: "9px 16px", borderRadius: 9, border: "none", background: promptCopied ? "#e6f7f1" : "#242322", color: promptCopied ? "#1e7a4d" : "#fff", cursor: "pointer", fontSize: 13, fontWeight: 700, whiteSpace: "nowrap" }}
                          >
                            {promptCopied ? "✓ 복사됨" : "클립보드에 복사"}
                          </button>
                          {promptDraft !== null && (
                            <button
                              onClick={() => setPromptDraft(null)}
                              title="직접 고친 내용을 버리고 자동 생성된 프롬프트로 되돌립니다"
                              style={{ padding: "9px 13px", borderRadius: 9, border: "1px solid rgba(36,35,34,.14)", background: "#fff", color: "#8a857f", cursor: "pointer", fontSize: 13, fontWeight: 600, whiteSpace: "nowrap" }}
                            >
                              원래대로
                            </button>
                          )}
                        </div>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            </div>
            {/* 고정된 문서를 보고 있다는 안내. 이 상태에서는 편집이 잠기고,
                현재 보드에서 다시 계산하는 내보내기(docx/마크다운/프롬프트)도 막는다 — 화면은 과거인데
                파일은 현재 내용으로 나오는 불일치를 만들지 않기 위해서다. */}
            {viewingSnapshot && (
              <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", background: "#f5f3fe", border: "1px solid #a99bf2", borderRadius: 12, padding: "12px 16px", marginBottom: 14 }}>
                <span style={{ fontSize: 13.5, fontWeight: 700, color: "#4f3fd6" }}>
                  고정된 문서를 보고 있습니다 · {new Date(viewingSnapshot.at).toLocaleString("ko-KR")}
                </span>
                <span style={{ fontSize: 12.5, color: "#6f6b66" }}>이 화면은 그 시점 내용이라 수정할 수 없습니다.</span>
                <button
                  onClick={() => setViewingSnapshotId(null)}
                  style={{ marginLeft: "auto", padding: "7px 13px", borderRadius: 8, border: "none", background: "#4f3fd6", color: "#fff", cursor: "pointer", fontSize: 12.5, fontWeight: 700, whiteSpace: "nowrap" }}
                >
                  현재 문서로 돌아가기
                </button>
              </div>
            )}
            <div ref={docContentRef} style={{ background: "#fff", border: "1px solid rgba(36,35,34,.1)", borderRadius: 16, padding: "34px 40px", boxShadow: "0 1px 3px rgba(0,0,0,.05)" }}>
            <div style={{ borderBottom: "2px solid #242322", paddingBottom: 14, marginBottom: 22 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: "#8a857f", letterSpacing: ".04em" }}>
                {shownDocType === "process" ? "과정 문서 · PROCESS" : "결과 문서 · RESULT"}
                {viewingSnapshot && ` · ${new Date(viewingSnapshot.at).toLocaleString("ko-KR")} 고정`}
              </div>
              <h1 style={{ fontSize: 24, fontWeight: 800, letterSpacing: "-.02em", margin: "8px 0 0" }}>{viewingSnapshot ? viewingSnapshot.title : selectedProject.title}</h1>
              <div style={{ fontSize: 14, color: "#8a857f", marginTop: 4 }}>
                {shownDocType === "process" ? "회의에서 오간 모든 의견의 기록" : "득표순으로 정리된 최종 우선순위"}
              </div>
            </div>

            {/* 문서 표준 필드(목적/배경/추진 방향/기대 효과): 프로젝트당 1개, 과정/결과 공통, 인라인 편집 */}
            <DocSection title="문서 표준 정보">
              <DocTable>
                <tbody>
                  {[
                    ["목적", "purpose"],
                    ["배경", "background"],
                    ["추진 방향", "direction"],
                    ["기대 효과", "expected"],
                  ].map(([label, key]) => (
                    <tr key={key}>
                      <th style={{ border: "1px solid #e0e0e0", padding: "9px 12px", textAlign: "left", background: "#f2f2f2", width: 120, whiteSpace: "nowrap", verticalAlign: "top" }}>{label}</th>
                      <td style={{ border: "1px solid #e0e0e0", padding: "6px 12px", verticalAlign: "top" }}>
                        {/* 고정된 문서를 볼 때는 편집 불가 — 여기서 고치면 스냅샷이 아니라 현재 문서가 바뀐다 */}
                        {docReadOnly ? (
                          <div style={{ whiteSpace: "pre-wrap", fontSize: 14, lineHeight: 1.6, color: docModel.docFields?.[key] ? "#242322" : "#a19c95" }}>
                            {docModel.docFields?.[key] || "—"}
                          </div>
                        ) : (
                          <textarea
                            defaultValue={board.docFields?.[key] || ""}
                            ref={autoSizeRef}
                            onInput={(e) => autoResizeTextarea(e.target)}
                            onFocus={() => {
                              suspendPollRef.current = true;
                            }}
                            onBlur={(e) => {
                              suspendPollRef.current = false;
                              updateDocField(key, e.target.value);
                            }}
                            placeholder={`${label}을(를) 입력하세요`}
                            style={{ width: "100%", boxSizing: "border-box", border: "none", background: "transparent", resize: "none", overflow: "hidden", fontSize: 14, fontFamily: "inherit", lineHeight: 1.6, outline: "none", minHeight: 24 }}
                          />
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </DocTable>
            </DocSection>

            {shownDocType === "process" ? (
              <>
                <DocSection title="개요">
                  <DocTable>
                    <tbody>
                      <DocKV k="프로젝트명" v={selectedProject.title} />
                      <DocKV k="참여자 수" v={`${docModel.participants.length}명`} />
                      <DocKV k="작성된 의견 수" v={`${board.notes.length}개`} />
                      <DocKV k="문제로 표시된 의견 수" v={`${docModel.problemNotes.length}개`} />
                    </tbody>
                  </DocTable>
                </DocSection>

                <DocSection title="참여자">
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

                <DocSection title="의견 모음 (과정)">
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

                <DocSection title="문제 정리 및 부가 설명">
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
                <DocSection title="개요">
                  <DocTable>
                    <tbody>
                      <DocKV k="프로젝트명" v={selectedProject.title} />
                      <DocKV k="문제로 표시된 의견 수" v={`${docModel.problemNotes.length}개`} />
                      <DocKV k="최다 득표" v={docModel.ranked[0] ? `${docModel.ranked[0].text} (${docModel.ranked[0].votes}표)` : "—"} />
                    </tbody>
                  </DocTable>
                </DocSection>

                <DocSection title="우선순위 TOP 5 결과">
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

            {/* 우선순위 해결여부 (회고 탭 토글 ON일 때만) — 기존 콘텐츠 뒤에 배치 */}
            {docModel.priorityCheckOn && (
              <DocSection title="우선순위 해결여부">
                <DocTable>
                  <thead>
                    <tr>
                      <DocTh>#</DocTh>
                      <DocTh>문제</DocTh>
                      <DocTh>득표</DocTh>
                      <DocTh>해결여부</DocTh>
                    </tr>
                  </thead>
                  <tbody>
                    {docModel.resolutionRows.length ? (
                      docModel.resolutionRows.map((r, i) => (
                        <tr key={r.id}>
                          <DocTd>{i + 1}</DocTd>
                          <DocTd>{r.text}</DocTd>
                          <DocTd>{r.votes}표</DocTd>
                          <DocTd>{RESOLUTION_LABELS[r.resolution] || <span style={{ color: "#aaa" }}>미정</span>}</DocTd>
                        </tr>
                      ))
                    ) : (
                      <DocEmpty span={4}>우선순위로 정리된 문제가 없습니다.</DocEmpty>
                    )}
                  </tbody>
                </DocTable>
              </DocSection>
            )}

            {/* 회고(KPT) — 완료한 참여자만 누적 표시 */}
            <DocSection title="회고 (KPT)">
              {docModel.completedRetros.length ? (
                docModel.completedRetros.map((r) => (
                  <div key={r.name} style={{ marginBottom: 14 }}>
                  <DocTable>
                    <tbody>
                      <tr>
                        <th colSpan={2} style={{ border: "1px solid #e0e0e0", padding: "9px 12px", textAlign: "left", background: "#f2f2f2", fontWeight: 700 }}>
                          <span style={{ display: "inline-flex", alignItems: "center", gap: 7 }}>
                            <span style={{ width: 12, height: 12, borderRadius: 999, background: r.color?.bg || "#ccc" }} />
                            {r.name}
                          </span>
                        </th>
                      </tr>
                      <tr>
                        <th style={{ border: "1px solid #e0e0e0", padding: "9px 12px", textAlign: "left", background: "#fafafa", width: 90, whiteSpace: "nowrap", verticalAlign: "top" }}>Keep</th>
                        <DocTd>{r.keep && r.keep.trim() ? r.keep : <span style={{ color: "#aaa" }}>—</span>}</DocTd>
                      </tr>
                      <tr>
                        <th style={{ border: "1px solid #e0e0e0", padding: "9px 12px", textAlign: "left", background: "#fafafa", width: 90, whiteSpace: "nowrap", verticalAlign: "top" }}>Problem</th>
                        <DocTd>{r.problem && r.problem.trim() ? r.problem : <span style={{ color: "#aaa" }}>—</span>}</DocTd>
                      </tr>
                      <tr>
                        <th style={{ border: "1px solid #e0e0e0", padding: "9px 12px", textAlign: "left", background: "#fafafa", width: 90, whiteSpace: "nowrap", verticalAlign: "top" }}>Try</th>
                        <DocTd>{r.try && r.try.trim() ? r.try : <span style={{ color: "#aaa" }}>—</span>}</DocTd>
                      </tr>
                    </tbody>
                  </DocTable>
                  </div>
                ))
              ) : (
                <div style={{ color: "#aaa", fontSize: 14 }}>완료된 회고가 없습니다.</div>
              )}
            </DocSection>

            {/* 회의 녹취록 — 회의록 녹음 내용이 있을 때만.
                음성 인식이 잘못 적은 부분을 고칠 수 있도록 문서 표준 4필드와 같은 방식으로 편집 가능하게 둔다.
                녹음 중에는 인식 결과가 계속 덧붙어 편집과 부딪히므로 그때만 읽기 전용으로 내린다. */}
            {docModel.minutes && (
              <DocSection title="회의 녹취록">
                {docReadOnly ? (
                  <div style={{ whiteSpace: "pre-wrap", fontSize: 14, lineHeight: 1.7, color: "#242322" }}>{docModel.minutes}</div>
                ) : minutesMutationBlocked ? (
                  <>
                    <div style={{ whiteSpace: "pre-wrap", fontSize: 14, lineHeight: 1.7, color: "#242322" }}>{docModel.minutes}</div>
                    <div style={{ fontSize: 12, color: "#a19c95", marginTop: 8 }}>
                      {micRecording ? "녹음 중에는 수정할 수 없습니다. 녹음을 멈추면 고칠 수 있어요." : `${recordingOwner}님이 녹음 중입니다. 멈추면 고칠 수 있어요.`}
                    </div>
                  </>
                ) : (
                  <textarea
                    key={docModel.minutes}
                    defaultValue={docModel.minutes}
                    ref={autoSizeRef}
                    onInput={(e) => autoResizeTextarea(e.target)}
                    onFocus={() => {
                      suspendPollRef.current = true;
                    }}
                    onBlur={(e) => {
                      suspendPollRef.current = false;
                      if (e.target.value !== docModel.minutes) updateMinutes(e.target.value);
                    }}
                    style={{ width: "100%", boxSizing: "border-box", border: "none", background: "transparent", resize: "none", overflow: "hidden", fontSize: 14, fontFamily: "inherit", lineHeight: 1.7, outline: "none", color: "#242322", minHeight: 24, padding: 0 }}
                  />
                )}
              </DocSection>
            )}
            </div>
          </motion.div>
        )}
        </AnimatePresence>
        </div>
      </div>

      <GuideCoach phase={activeTab} onGotoScreen={setActiveTab} user={user} />

      {/* 회의록(minutes) 패널: 헤더 "회의록 녹음"으로 열린다. 전체 회의를 누적하고 .txt·문서로 내보낸다. */}
      <AnimatePresence>
        {minutesOpen && (
          <motion.div
            key="minutes-panel"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 20 }}
            transition={{ duration: 0.22, ease: EASE }}
            style={{
              position: "fixed",
              left: 20,
              bottom: 20,
              width: "min(440px, calc(100vw - 40px))",
              maxHeight: "min(60vh, 520px)",
              background: "#fff",
              border: "1px solid rgba(36,35,34,.12)",
              borderRadius: 16,
              boxShadow: "0 12px 40px rgba(0,0,0,.22)",
              zIndex: 200,
              display: "flex",
              flexDirection: "column",
              overflow: "hidden",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, padding: "14px 16px", borderBottom: "1px solid rgba(36,35,34,.08)" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                {minutesRecording && <span style={{ width: 9, height: 9, borderRadius: 999, background: "#ff4242", animation: "oaRecPulse 1.1s ease-in-out infinite", flexShrink: 0 }} />}
                <span style={{ fontSize: 14, fontWeight: 700, whiteSpace: "nowrap" }}>
                  {minutesRecording ? "회의록 녹음 중 · 실시간 변환" : "회의록"}
                </span>
                {/* 탭 오디오 캡처 진행 상태 배지. "최상"은 자막에도 반영 중, "중간"은 파일에만 반영 중임을 알려
                    자막이 내 목소리만 담기는 이유를 사용자가 오해하지 않게 한다. */}
                {minutesRecording && recordingTier === "tab-audio-full" && (
                  <span title="탭/화면 오디오가 실시간 자막에도 반영되고 있습니다(실험적 기능)" style={{ fontSize: 11, fontWeight: 700, color: "#4f3fd6", background: "#ece9fc", borderRadius: 999, padding: "2px 8px", whiteSpace: "nowrap" }}>
                    탭 오디오 포함
                  </span>
                )}
                {minutesRecording && recordingTier === "tab-audio-file-only" && (
                  <span title="자막은 마이크만 반영하지만, 저장될 오디오 파일에는 탭 오디오도 함께 담깁니다" style={{ fontSize: 11, fontWeight: 700, color: "#8a7300", background: "#fff6da", borderRadius: 999, padding: "2px 8px", whiteSpace: "nowrap" }}>
                    탭 오디오는 파일에만
                  </span>
                )}
              </div>
              <button
                onClick={() => setMinutesOpen(false)}
                title="닫기"
                style={{ border: "none", background: "none", cursor: "pointer", color: "#a19c95", fontSize: 18, lineHeight: 1, padding: 4 }}
              >
                ×
              </button>
            </div>

            <div style={{ padding: "14px 16px", overflowY: "auto", flex: 1 }}>
              {!minutes && !minutesInterim ? (
                <div style={{ color: "#a19c95", fontSize: 13.5, lineHeight: 1.6 }}>
                  {minutesRecording
                    ? "말을 시작하면 여기에 회의 내용이 계속 쌓입니다. (온라인 회의라면 스피커 볼륨을 켜두세요)"
                    : "전체 회의 녹취록입니다. '회의록 녹음'을 눌러 시작하세요. 멈추면 문서에 자동 반영됩니다."}
                </div>
              ) : (
                <div style={{ fontSize: 14, lineHeight: 1.7, whiteSpace: "pre-wrap", color: "#242322" }}>
                  {minutes}
                  {minutesInterim && <span style={{ color: "#a19c95" }}>{minutes ? " " : ""}{minutesInterim}</span>}
                </div>
              )}
            </div>

            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, padding: "12px 16px", borderTop: "1px solid rgba(36,35,34,.08)", background: "#faf9f7" }}>
              <div style={{ width: "100%", fontSize: 12, lineHeight: 1.5, color: "#a19c95" }}>
                {!minutesRecording && recordingTier === "tab-audio-file-only" && recordedAudioUrl
                  ? "방금 녹음은 실시간 자막에 내 목소리만 반영됐지만, 저장된 오디오 파일에는 상대방 목소리도 함께 담겨 있어요. 아래에서 내려받을 수 있습니다."
                  : board.minutesClosed && !minutesRecording
                  ? '녹음을 종료했습니다. 문서 탭의 "회의 녹취록"에 반영됐고, 문서에서 직접 고칠 수도 있습니다. 다시 녹음하면 뒤에 이어서 쌓입니다.'
                  : '"일시정지"는 마이크만 놓고 나중에 이어서 녹음할 수 있고, "종료"는 녹음을 마치고 문서에 반영합니다(둘 다 지금까지의 내용은 그대로 남습니다). "중복 정리"는 반복된 문장·단어만 걷어냅니다(요약 아님).'}
              </div>
              {/* 녹음 중에는 "일시정지"(이어서 녹음 가능)와 "종료"(문서 반영 후 마감)를 따로 둔다.
                  멈춰 있을 때는 시작 버튼 하나만 보이고, 다른 사람이 녹음 중이면 비활성화하며
                  누가 녹음 중인지 알려준다(그 사람이 멈추거나 하트비트가 끊기면 자동 해제). */}
              {minutesRecording ? (
                <>
                  <button
                    onClick={pauseRecording}
                    title="마이크만 잠시 놓습니다. 다시 누르면 이어서 녹음됩니다."
                    style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 13px", borderRadius: 8, border: "1px solid #ffcaca", background: "#fdeaea", color: "#d32f2f", cursor: "pointer", fontSize: 13, fontWeight: 600 }}
                  >
                    <span style={{ width: 8, height: 8, borderRadius: 999, background: "#ff4242", animation: "oaRecPulse 1.1s ease-in-out infinite" }} />
                    일시정지
                  </button>
                  <button
                    onClick={endRecording}
                    title="녹음을 마치고 문서에 반영합니다(녹취록은 지워지지 않습니다)"
                    style={{ padding: "8px 13px", borderRadius: 8, border: "none", background: "#242322", color: "#fff", cursor: "pointer", fontSize: 13, fontWeight: 600 }}
                  >
                    종료
                  </button>
                </>
              ) : (
                <>
                  {/* 탭/화면 오디오 옵션 — 브라우저 지원 힌트가 없는 Firefox·Safari 등에서는 아예 숨긴다.
                      실제 지원 여부의 최종 판단은 시작 시점의 하드 체크(getDisplayMedia 결과)로 한다. */}
                  {supportsTabAudioCaptureUA() && (
                    <label
                      style={{
                        width: "100%",
                        display: "flex",
                        alignItems: "flex-start",
                        gap: 7,
                        fontSize: 12.5,
                        fontWeight: 600,
                        color: "#242322",
                        cursor: recordingLockedByOther ? "not-allowed" : "pointer",
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={tabAudioOption}
                        disabled={recordingLockedByOther}
                        onChange={(e) => setTabAudioOption(e.target.checked)}
                        style={{ marginTop: 2 }}
                      />
                      <span>
                        탭/화면 오디오도 함께 녹음 (실험적)
                        {tabAudioOption && (
                          <span style={{ display: "block", fontWeight: 400, fontSize: 11.5, color: "#a19c95", marginTop: 2 }}>
                            공유 화면을 고를 때 <b>오디오 공유</b>를 꼭 체크해 주세요. 헤드폰 없이 쓰면 스피커 소리를 마이크가 다시 주워 자막이 중복될 수 있어요.
                          </span>
                        )}
                      </span>
                    </label>
                  )}
                  <button
                    onClick={startRecording}
                    disabled={recordingLockedByOther}
                    title={recordingLockedByOther ? `${recordingOwner}님이 녹음 중입니다. 한 번에 한 명만 녹음할 수 있어요.` : ""}
                    style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 13px", borderRadius: 8, border: "1px solid rgba(36,35,34,.14)", background: recordingLockedByOther ? "#f4f2ef" : "#fff", color: recordingLockedByOther ? "#a19c95" : "#242322", cursor: recordingLockedByOther ? "not-allowed" : "pointer", fontSize: 13, fontWeight: 600 }}
                  >
                    <span style={{ width: 8, height: 8, borderRadius: 999, background: recordingLockedByOther ? "#c4bfb8" : "#ff4242", animation: recordingLockedByOther ? "oaRecPulse 1.1s ease-in-out infinite" : "none" }} />
                    {recordingLockedByOther
                      ? `${recordingOwner}님이 녹음 중입니다`
                      : minutes && !board.minutesClosed
                      ? "이어서 녹음"
                      : "회의록 녹음"}
                  </button>
                </>
              )}
              {/* 인식 언어. 녹음 중에는 바꿀 수 없다 — 도중에 바꾸면 현재 인식기에는 반영되지 않아
                  "바꿨는데 그대로"로 보이기 때문. 멈춘 뒤 바꿔서 이어 녹음하면 그때부터 적용된다. */}
              <select
                value={minutesLang}
                onChange={(e) => setMinutesLang(e.target.value)}
                disabled={minutesRecording || recordingLockedByOther}
                title={minutesRecording ? "녹음을 멈춘 뒤에 언어를 바꿀 수 있어요" : "인식할 언어"}
                style={{ padding: "8px 10px", borderRadius: 8, border: "1px solid rgba(36,35,34,.14)", background: "#fff", color: minutesRecording || recordingLockedByOther ? "#c4bfb8" : "#242322", cursor: minutesRecording || recordingLockedByOther ? "not-allowed" : "pointer", fontSize: 13, fontWeight: 600, fontFamily: "inherit" }}
              >
                <option value="ko-KR">한국어</option>
                <option value="en-US">English</option>
              </select>
              {/* 남이 녹음 중일 때도 막는다: 지금 고쳐도 곧 그 사람의 하트비트 저장이 덮어써서
                  "정리했는데 되돌아오는" 것처럼 보이기 때문 */}
              <button
                onClick={cleanupMinutes}
                disabled={!minutes || minutesMutationBlocked}
                title={recordingLockedByOther ? `${recordingOwner}님이 녹음 중일 때는 수정할 수 없습니다` : "반복된 문장·단어를 제거합니다(요약은 아님)"}
                style={{ padding: "8px 13px", borderRadius: 8, border: "1px solid rgba(36,35,34,.14)", background: "#fff", color: minutes && !minutesMutationBlocked ? "#242322" : "#c4bfb8", cursor: minutes && !minutesMutationBlocked ? "pointer" : "not-allowed", fontSize: 13, fontWeight: 600 }}
              >
                중복 정리
              </button>
              <button
                onClick={copyMinutes}
                disabled={!minutes}
                style={{ padding: "8px 13px", borderRadius: 8, border: "1px solid rgba(36,35,34,.14)", background: "#fff", color: minutes ? "#242322" : "#c4bfb8", cursor: minutes ? "pointer" : "not-allowed", fontSize: 13, fontWeight: 600 }}
              >
                복사
              </button>
              <button
                onClick={downloadMinutes}
                disabled={!minutes}
                style={{ padding: "8px 13px", borderRadius: 8, border: "none", background: minutes ? "#242322" : "#f0ede8", color: minutes ? "#fff" : "#c4bfb8", cursor: minutes ? "pointer" : "not-allowed", fontSize: 13, fontWeight: 600 }}
              >
                .txt 다운로드
              </button>
              {/* 탭 오디오를 섞어 녹음한 세션에만 나타난다(마이크 단독 경로는 파일 저장 자체를 하지 않는다). */}
              {recordedAudioUrl && (
                <a
                  href={recordedAudioUrl}
                  download={`${selectedProject?.title || "회의록"}-녹음.webm`}
                  style={{ display: "flex", alignItems: "center", padding: "8px 13px", borderRadius: 8, border: "1px solid rgba(36,35,34,.14)", background: "#fff", color: "#242322", cursor: "pointer", fontSize: 13, fontWeight: 600, textDecoration: "none" }}
                >
                  🎧 녹음 파일(.webm) 다운로드
                </a>
              )}
              <button
                onClick={clearMinutes}
                disabled={!minutes || minutesMutationBlocked}
                title={recordingLockedByOther ? `${recordingOwner}님이 녹음 중일 때는 수정할 수 없습니다` : ""}
                style={{ marginLeft: "auto", padding: "8px 13px", borderRadius: 8, border: "none", background: "none", color: minutes && !minutesMutationBlocked ? "#a19c95" : "#d5d1cb", cursor: minutes && !minutesMutationBlocked ? "pointer" : "not-allowed", fontSize: 13, fontWeight: 600 }}
              >
                내용 지우기
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

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
