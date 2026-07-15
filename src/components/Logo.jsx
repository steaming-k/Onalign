// 상단 고정 로고. 지금은 이미지가 없어 색상 사각형 placeholder + "Onalign" 텍스트로 대체.
// 나중에 이미지가 생기면 아래 placeholder <span>을 <img src="/logo.svg" .../>로 교체만 하면 된다.
export default function Logo({ onClick }) {
  return (
    <button
      onClick={onClick}
      aria-label="Onalign 홈으로"
      title="홈으로"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        border: "none",
        background: "none",
        cursor: "pointer",
        padding: 0,
        fontFamily: "sans-serif",
      }}
    >
      {/* 로고 이미지 자리(placeholder) */}
      <span
        style={{
          width: 26,
          height: 26,
          borderRadius: 7,
          background: "#a9e6d3",
          border: "1px solid #72c9ac",
          display: "inline-block",
          flexShrink: 0,
        }}
      />
      <span style={{ fontSize: 17, fontWeight: 800, letterSpacing: "-0.02em", color: "#202020" }}>Onalign</span>
    </button>
  );
}
