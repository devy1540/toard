const PREVIEW_CHARS = 200;
const REQUEST_MARKER_RE = /(?:^|\n)#{1,6}\s*My request for [^:\n]+:\s*/i;
const GENERATED_ATTACHMENT_LINE_RE =
  /^\s*#{1,6}\s+(?:[\w.-]+-)?(?:codex-clipboard|claude-clipboard)[^\n]*$/gim;

/** 첨부 메타데이터를 걷어내고 실제 사용자 요청을 한 줄 미리보기로 만든다. */
export function toHistoryPreview(text: string): string {
  const requestMarker = REQUEST_MARKER_RE.exec(text);
  const candidate = requestMarker && requestMarker.index >= 0
    ? text.slice(requestMarker.index + requestMarker[0].length)
    : text;
  const cleaned = candidate
    .replace(/<image\b[\s\S]*?<\/image>/gi, " ")
    .replace(/<image\b[^>]*>/gi, " ")
    .replace(/^\s*#{1,6}\s*files? mentioned by the user:\s*$/gim, " ")
    .replace(GENERATED_ATTACHMENT_LINE_RE, " ");
  const oneLine = cleaned.replace(/\s+/g, " ").trim();
  return oneLine.length > PREVIEW_CHARS ? `${oneLine.slice(0, PREVIEW_CHARS)}…` : oneLine;
}
