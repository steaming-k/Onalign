// 구글 로그인 상태를 앱 전역에서 쓰기 위한 훅. GitHub 등 다른 프로바이더는 이번 범위 밖(추후 별도 추가).
import { useState, useEffect, useCallback } from "react";
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

export function useAuth() {
  // undefined = 아직 세션 확인 중, null = 로그아웃 상태, 객체 = 로그인됨
  const [session, setSession] = useState(undefined);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      if (data.session?.user) ensureProfile(data.session.user);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => {
      setSession(s);
      if (s?.user) ensureProfile(s.user);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  const signInWithGoogle = useCallback(() => {
    // 공유 링크(?p=id)로 들어온 뒤 로그인하는 경우 이 쿼리스트링이 없으면 로그인 후
    // 목록/생성 화면으로 떨어져버린다 — OAuth 왕복 후에도 원래 있던 프로젝트로 돌아오게 유지한다.
    return supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: `${window.location.origin}/app.html${window.location.search}` },
    });
  }, []);

  const signOut = useCallback(() => supabase.auth.signOut(), []);

  return {
    session,
    user: session?.user ?? null,
    authLoading: session === undefined,
    signInWithGoogle,
    signOut,
  };
}
