// 상단 고정 로고. public/onalign-logo.png(말풍선 3개 + Onalign 워드마크)를 그대로 사용한다.
export default function Logo({ onClick, height = 34 }) {
  return (
    <button
      onClick={onClick}
      aria-label="Onalign 홈으로"
      title="홈으로"
      style={{
        display: "flex",
        alignItems: "center",
        border: "none",
        background: "none",
        cursor: "pointer",
        padding: 0,
      }}
    >
      <img src="/onalign-logo.png" alt="Onalign" style={{ height, width: "auto", display: "block" }} />
    </button>
  );
}
