// window.storage(Claude.ai 아티팩트 전용 API)를 대체하는 Supabase 어댑터.
// 키-값 하나를 kv_store 테이블의 한 행(key, value)으로 저장한다. (스키마: supabase/schema.sql)
//
// 동시 편집 대응: 보드는 JSON 하나를 통째로 읽고 고쳐 다시 쓰는 구조라, 두 사람의 저장이 겹치면
// 나중 저장이 앞선 저장을 통째로 덮어써 상대의 포스트잇이 사라졌다(실측: 5명 동시 작성 시 1개만 생존).
// 그래서 "읽었을 때의 updated_at이 그대로일 때만 쓴다"는 조건부 저장(setIfUnchanged)을 둔다.
// 조건이 깨지면 conflict를 돌려주고, 호출부가 최신값을 다시 읽어 변경을 재적용한다.
import { supabase } from "./supabaseClient";

export const storage = {
  // 성공 시 { value, updatedAt }, 행이 없으면 null.
  // 에러는 던진다 — "네트워크 실패"와 "그 행이 실제로 없음"을 호출부가 구분해야 하기 때문.
  // (둘 다 null로 뭉뚱그리면, 저장 실패를 빈 보드로 오인해 덮어쓰는 사고가 난다.)
  get: async (key) => {
    const { data, error } = await supabase.from("kv_store").select("value, updated_at").eq("key", key).maybeSingle();
    if (error) throw error;
    if (!data) return null;
    return { value: data.value, updatedAt: data.updated_at };
  },

  // 조건 없이 덮어쓴다. 새 프로젝트의 빈 보드를 처음 만들 때처럼 경합이 없는 경로에서만 쓴다.
  set: async (key, value) => {
    const { error } = await supabase.from("kv_store").upsert({ key, value, updated_at: new Date().toISOString() });
    if (error) throw error;
  },

  // 조건부 저장. expectedUpdatedAt이 null이면 "아직 행이 없다"고 보고 insert를 시도한다
  // (같은 키를 동시에 만들면 PK 충돌로 하나만 성공하고, 나머지는 conflict로 돌아온다).
  // 반환: { ok: true, updatedAt } | { ok: false, conflict: true }
  setIfUnchanged: async (key, value, expectedUpdatedAt) => {
    const stamp = new Date().toISOString();
    // 다음 조건부 저장의 기준값으로 쓰려면 "서버에 실제로 저장된 형식"을 그대로 받아와야 한다.
    // 우리가 만든 ISO 문자열과 Postgres가 돌려주는 표기가 달라질 수 있어(소수점 자릿수 등)
    // select로 저장된 updated_at을 되받아 그 값을 기준으로 삼는다.
    if (expectedUpdatedAt == null) {
      const { data, error } = await supabase
        .from("kv_store")
        .insert({ key, value, updated_at: stamp })
        .select("updated_at");
      if (error) return { ok: false, conflict: true }; // PK 충돌 = 이미 누가 만들었다
      return { ok: true, updatedAt: data?.[0]?.updated_at ?? stamp };
    }
    const { data, error } = await supabase
      .from("kv_store")
      .update({ value, updated_at: stamp })
      .eq("key", key)
      .eq("updated_at", expectedUpdatedAt)
      .select("updated_at");
    if (error) throw error;
    // 0행이면 그사이 누군가 먼저 저장했다는 뜻(또는 행이 사라졌다) -> 재시도 대상
    if (!data || data.length === 0) return { ok: false, conflict: true };
    return { ok: true, updatedAt: data[0].updated_at };
  },

  delete: async (key) => {
    const { error } = await supabase.from("kv_store").delete().eq("key", key);
    if (error) throw error;
  },
};
