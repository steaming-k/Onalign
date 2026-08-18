// 구글 로그인 상태를 앱 전역에서 쓰기 위한 훅. GitHub 등 다른 프로바이더는 이번 범위 밖(추후 별도 추가).
import { useState, useEffect, useCallback, useRef } from "react";
import { supabase } from "./supabaseClient";

// 로그인 성공 시 profiles 행이 없으면 최초 1회 생성한다("최초 로그인 시 프로필 생성").
async function ensureProfile(user) {
  if (!user) return;
  const { data: existing } = await supabase.from("profiles").select("id").eq("id", user.id).maybeSingle();
  if (existing) return;
  await supabase.from("profiles").insert({
    id: user.id,
    email: user.email,
    display_name: user.user_metadata?.full_name || user.user_metadata?.name || user.email || "",
  });
}

// ===== 1시간 무활동 자동 로그아웃 =====
// supabase-js는 기본적으로 refresh token으로 세션을 계속 갱신해서, 가만히 둬도 로그인 상태가
// 사실상 무기한 유지된다. "1시간 이상 활동이 없으면 로그아웃"을 위해 마지막 활동 시각을 직접 추적한다.
// localStorage에 저장하는 이유: 탭을 닫았다 다시 열어도(브라우저는 다시 켜졌지만 실제로는 1시간 넘게
// 아무도 안 쓴 상태) 만료 판정이 이어져야 하기 때문 — 메모리(useState)에만 두면 새로고침마다 초기화돼버린다.
const IDLE_TIMEOUT_MS = 60 * 60 * 1000;
const LAST_ACTIVE_KEY = "onalign-last-active";
// mousemove는 빼둔다 — 마우스를 화면 위에 올려만 둬도 초당 수십 번씩 울려서 낭비가 크고,
// 클릭·키보드·스크롤·터치만으로도 "실제로 쓰고 있다"를 판단하기에 충분하다.
const ACTIVITY_EVENTS = ["mousedown", "keydown", "scroll", "touchstart", "wheel"];

function markActive() {
  try {
    const now = Date.now();
    const last = Number(localStorage.getItem(LAST_ACTIVE_KEY)) || 0;
    if (now - last < 5000) return; // 활동 이벤트가 잦으므로 5초에 한 번만 써서 불필요한 쓰기를 줄인다
    localStorage.setItem(LAST_ACTIVE_KEY, String(now));
  } catch (e) {
    /* 시크릿 모드 등 localStorage 접근 불가 시에도 로그인 자체는 계속되도록 조용히 무시 */
  }
}

function isIdleExpired() {
  try {
    const last = Number(localStorage.getItem(LAST_ACTIVE_KEY));
    if (!last) return false; // 기록이 아직 없으면(방금 로그인 등) 만료로 보지 않는다
    return Date.now() - last > IDLE_TIMEOUT_MS;
  } catch (e) {
    return false;
  }
}

// suspendIdleRef: 호출 쪽에서 넘기는 ref. current가 true인 동안은(예: 회의 녹음 중) 무활동으로
// 보지 않고 오히려 활동시각을 계속 갱신한다 — 회의 중 마우스·키보드 조작이 없어도 로그아웃되지 않게 하기 위함.
export function useAuth(suspendIdleRef) {
  // undefined = 아직 세션 확인 중, null = 로그아웃 상태, 객체 = 로그인됨
  const [session, setSession] = useState(undefined);
  // 세션이 "예상 못 하게" 사라졌는지(구글 토큰 만료, refresh 실패, 1시간 무활동 등) — 사용자가
  // 직접 "로그아웃" 버튼을 눌러서 없어진 거라면 false로, 그 외 모든 경우는 true로 남는다.
  // manualSignOutRef로 구분한다: 로그아웃 버튼(아래 signOut)만 이 ref를 세팅하고 나머지 경로
  // (아이들 타임아웃, 토큰 만료 등)는 supabase.auth.signOut()을 직접 불러 이 플래그를 안 건드리므로
  // "의도치 않게 사라짐"으로 정확히 분류된다.
  const [sessionExpired, setSessionExpired] = useState(false);
  const manualSignOutRef = useRef(false);
  // onAuthStateChange 클로저는 최초 렌더의 session(undefined)을 그대로 들고 있어 매번 최신값을
  // 못 봐서, "로그인 상태였었는지"는 session state 대신 이 ref로 따로 추적한다.
  const hadSessionRef = useRef(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      // 새로고침·재방문 시점에 이미 1시간 넘게 활동이 없었다면, 세션을 복원하지 않고 바로 로그아웃한다.
      // (그대로 setSession하면 "잠깐 로그인 화면이 보였다 로그아웃"처럼 깜빡여서, 여기서 먼저 걸러낸다.)
      if (data.session?.user && isIdleExpired()) {
        supabase.auth.signOut();
        setSession(null);
        setSessionExpired(true);
        return;
      }
      setSession(data.session);
      if (data.session?.user) {
        ensureProfile(data.session.user);
        markActive();
        hadSessionRef.current = true;
      }
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => {
      if (!s && hadSessionRef.current) {
        setSessionExpired(!manualSignOutRef.current);
      }
      manualSignOutRef.current = false; // 한 번 판정에 썼으면 소모한다
      setSession(s);
      if (s?.user) {
        ensureProfile(s.user);
        markActive(); // 로그인 직후 시계를 "지금"으로 맞춰, 예전 활동 기록 때문에 곧바로 만료 처리되지 않게 한다
        hadSessionRef.current = true;
        setSessionExpired(false); // 다시 로그인했으면 만료 안내는 내린다
      } else {
        hadSessionRef.current = false;
      }
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  // 로그인 중일 때만: (1) 클릭·키보드·스크롤 등 활동이 있으면 마지막 활동 시각 갱신,
  // (2) 60초마다 만료 여부 점검(활동 없이 탭을 켜둔 경우), (3) 탭이 백그라운드에 있다 다시 보일 때도
  // 즉시 한 번 점검한다 — 백그라운드 탭은 브라우저가 타이머 실행을 늦추거나 건너뛸 수 있어서,
  // 다시 눈에 띄는 시점에 놓치지 않고 확인해야 한다.
  useEffect(() => {
    if (!session?.user) return;
    const onActivity = () => markActive();
    ACTIVITY_EVENTS.forEach((ev) => window.addEventListener(ev, onActivity, { passive: true }));
    const checkExpired = () => {
      if (suspendIdleRef?.current) {
        markActive(); // 녹음 등 진행 중 — 무활동 판정을 미루고 시계를 계속 지금으로 맞춘다
        return;
      }
      if (isIdleExpired()) supabase.auth.signOut();
    };
    const iv = setInterval(checkExpired, 60 * 1000);
    const onVisible = () => {
      if (document.visibilityState === "visible") checkExpired();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      ACTIVITY_EVENTS.forEach((ev) => window.removeEventListener(ev, onActivity));
      document.removeEventListener("visibilitychange", onVisible);
      clearInterval(iv);
    };
  }, [session?.user]);

  const signInWithGoogle = useCallback(() => {
    // 공유 링크(?p=id)로 들어온 뒤 로그인하는 경우 이 쿼리스트링이 없으면 로그인 후
    // 목록/생성 화면으로 떨어져버린다 — OAuth 왕복 후에도 원래 있던 프로젝트로 돌아오게 유지한다.
    return supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: `${window.location.origin}/app.html${window.location.search}` },
    });
  }, []);

  const signOut = useCallback(() => {
    manualSignOutRef.current = true; // 이 sign-out은 사용자가 직접 누른 것 — 만료 안내를 띄우지 않는다
    return supabase.auth.signOut();
  }, []);

  return {
    session,
    user: session?.user ?? null,
    authLoading: session === undefined,
    sessionExpired,
    signInWithGoogle,
    signOut,
  };
}
