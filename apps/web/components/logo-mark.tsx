import type { SVGProps } from "react";

/**
 * toard 브랜드 마크 — 여러 프로바이더(소스)가 하나로 수렴해 상승하는 형태.
 * favicon(app/icon.svg)과 동일한 아트. 배경·색 없이 글리프만, currentColor를 상속해
 * 뉴트럴 UI(라이트=전경 검정 / 다크=전경 흰색)와 자동으로 일관되게 렌더된다.
 */
export function LogoMark({ size = 28, ...props }: { size?: number } & Omit<SVGProps<SVGSVGElement>, "width" | "height">) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
      {...props}
    >
      <g stroke="currentColor" fill="none" strokeLinecap="round" strokeLinejoin="round">
        <path d="M15 18 34 32 M15 32 34 32 M15 46 34 32" strokeWidth="5" />
        <path d="M34 32 50 16" strokeWidth="5.5" />
      </g>
    </svg>
  );
}
