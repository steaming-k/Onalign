// window.storage(Claude.ai 아티팩트 전용 API)를 대체하는 Supabase 어댑터.
// 반환 형태({ value })와 메서드 시그니처를 기존과 동일하게 맞춰,
// 보드 컴포넌트 코드를 전혀 건드리지 않고 백엔드만 교체했다.
// 키-값 하나를 kv_store 테이블의 한 행(key, value)으로 저장한다. (스키마: supabase/schema.sql)
import { supabase } from "./supabaseClient";

export const storage = {
  get: async (key) => {
    const { data, error } = await supabase.from("kv_store").select("value").eq("key", key).maybeSingle();
    if (error || !data) return null;
    return { value: data.value };
  },
  set: async (key, value) => {
    await supabase.from("kv_store").upsert({ key, value, updated_at: new Date().toISOString() });
  },
  delete: async (key) => {
    await supabase.from("kv_store").delete().eq("key", key);
  },
};
