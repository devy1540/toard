type TokenUsageRow = {
  totalTokens: number;
};

/** 구성 카드의 순위는 총 사용 토큰이 많은 항목부터 보여준다. */
export function orderByTokens<T extends TokenUsageRow>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => b.totalTokens - a.totalTokens);
}

/** 구성 막대와 백분율은 총 사용 토큰을 분모로 계산한다. */
export function tokenShare(tokens: number, totalTokens: number): number {
  return totalTokens > 0 ? tokens / totalTokens : 0;
}
