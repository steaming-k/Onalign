import { createClient } from "@supabase/supabase-js";

// publishable key(구 anon key)는 RLS로 보호되는 것을 전제로 클라이언트 번들에 노출되는 게 정상이라
// 별도 .env 없이 바로 심는다. 프로젝트를 바꾸게 되면 이 두 값만 교체하면 된다.
const SUPABASE_URL = "https://vermnkntmmnambeilzkx.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_otbqNVMJh1-La6aiMHMFgA_QuwE8hIy";

export const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
