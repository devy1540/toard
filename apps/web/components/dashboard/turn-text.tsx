// 히스토리 턴 본문 — 길면 CSS 만으로 접는다(체크박스+label, JS 불필요 → 서버 렌더로도 동작).
// 짧은 본문은 토글 없이 그대로 노출. id 는 페이지에서 턴마다 유니크하게 넘긴다.
// peer 패턴 주의: peer-checked 를 받는 요소(p·label)는 input 의 "형제"여야 한다(label 안 span 은 X).

const CLAMP_LINES = 6;

// 이 줄 수/글자 수를 넘으면 접기 대상. (실제 줄바꿈은 렌더 폭에 따라 달라져 근사치)
function isLong(text: string): boolean {
  return text.length > 500 || text.split("\n").length > CLAMP_LINES;
}

export function TurnText({
  id,
  text,
  more,
  less,
}: {
  id: string;
  text: string;
  more: string;
  less: string;
}) {
  if (!isLong(text)) {
    return <p className="text-sm break-words whitespace-pre-wrap">{text}</p>;
  }
  // display 유틸은 라벨별로만 지정 — 공용 문자열에 inline-block 을 두면 hidden 과
  // 같은 우선순위로 충돌해 두 라벨이 동시에 보인다.
  const link =
    "text-muted-foreground hover:text-foreground mt-1 cursor-pointer text-xs font-medium select-none";
  return (
    <div>
      <input type="checkbox" id={id} className="peer sr-only" />
      <p className="text-sm break-words whitespace-pre-wrap line-clamp-6 peer-checked:line-clamp-none">
        {text}
      </p>
      {/* 두 label 모두 input 의 형제 → peer-checked 로 교차 토글 */}
      <label htmlFor={id} className={`${link} inline-block peer-checked:hidden`}>
        {more}
      </label>
      <label htmlFor={id} className={`${link} hidden peer-checked:inline-block`}>
        {less}
      </label>
    </div>
  );
}
