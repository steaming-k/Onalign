import { motion, AnimatePresence } from "framer-motion";

// 재사용 확인 팝업. 화면 전체를 덮는 모달이 아니라, 위쪽에 뜨는 작은 카드.
// 바깥 레이어는 pointerEvents:none이라 뒤 화면 클릭을 막지 않고, 팝업 카드만 조작 가능하다.
export default function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = "삭제",
  cancelLabel = "취소",
  onConfirm,
  onCancel,
}) {
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9997,
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        pointerEvents: "none",
      }}
    >
      <AnimatePresence>
        {open && (
          <motion.div
            key="confirm-card"
            initial={{ opacity: 0, scale: 0.94, y: -6 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.94, y: -6 }}
            transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
            style={{
              pointerEvents: "auto",
              marginTop: "16vh",
              width: 320,
              maxWidth: "90vw",
              background: "#fff",
              border: "1px solid #e0e0e0",
              borderRadius: 12,
              boxShadow: "0 14px 44px rgba(0,0,0,.2)",
              padding: 18,
              fontFamily: "sans-serif",
            }}
          >
            {title && <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 6, color: "#202020" }}>{title}</div>}
            <div style={{ fontSize: 14, color: "#555", lineHeight: 1.5, marginBottom: 16 }}>{message}</div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button
                onClick={onCancel}
                style={{ border: "1px solid #ddd", background: "#fff", color: "#333", borderRadius: 8, padding: "7px 14px", fontSize: 13, cursor: "pointer" }}
              >
                {cancelLabel}
              </button>
              <button
                onClick={onConfirm}
                style={{ border: "none", background: "#c0392b", color: "#fff", borderRadius: 8, padding: "7px 14px", fontSize: 13, fontWeight: 600, cursor: "pointer" }}
              >
                {confirmLabel}
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
