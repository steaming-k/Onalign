// window.storage(Claude.ai 아티팩트 전용 API)를 대체하는 localStorage 어댑터.
// 반환 형태({ value })와 메서드 시그니처를 기존과 동일하게 맞춰,
// 보드 컴포넌트 코드를 거의 그대로 재사용할 수 있게 한다.
//
// 다음 단계(3번, 로그인/DB)에서는 이 파일만 Supabase 구현으로 교체하면 된다:
//   get(key)  -> supabase.from('boards').select().eq('key', key).single()
//   set(key,v)-> supabase.from('boards').upsert(...)
//   delete    -> supabase.from('boards').delete().eq('key', key)
// 두 번째 인자(shared)는 아티팩트 호환용으로 받되 무시한다.
export const storage = {
  get: (key) => {
    try {
      const v = localStorage.getItem(key);
      return Promise.resolve(v !== null ? { value: v } : null);
    } catch (e) {
      return Promise.resolve(null);
    }
  },
  set: (key, value) => {
    try {
      localStorage.setItem(key, value);
    } catch (e) {
      /* 용량 초과 등은 무시 */
    }
    return Promise.resolve();
  },
  delete: (key) => {
    try {
      localStorage.removeItem(key);
    } catch (e) {
      /* noop */
    }
    return Promise.resolve();
  },
};
