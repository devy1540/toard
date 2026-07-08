import type { ReactNode } from "react";

// 히스토리 턴 본문 — 길면 CSS 만으로 접는다(체크박스+label, JS 불필요 → 서버 렌더로도 동작).
// 짧은 본문은 토글 없이 그대로 노출. id 는 페이지에서 턴마다 유니크하게 넘긴다.
// peer 패턴 주의: peer-checked 를 받는 요소(div·label)는 input 의 "형제"여야 한다(label 안 span 은 X).

const CLAMP_LINES = 6;

type Block =
  | { type: "paragraph"; text: string }
  | { type: "code"; text: string; lang?: string }
  | { type: "table"; header: string[]; rows: string[][] }
  | { type: "list"; ordered: boolean; items: string[] }
  | { type: "quote"; text: string }
  | { type: "rule" };

// 이 줄 수/글자 수를 넘으면 접기 대상. (실제 줄바꿈은 렌더 폭에 따라 달라져 근사치)
function isLong(text: string): boolean {
  return text.length > 500 || text.split("\n").length > CLAMP_LINES;
}

function isFence(line: string): boolean {
  return line.trim().startsWith("```");
}

function splitTableRow(line: string): string[] {
  let normalized = line.trim();
  if (normalized.startsWith("|")) normalized = normalized.slice(1);
  if (normalized.endsWith("|")) normalized = normalized.slice(0, -1);
  return normalized.split("|").map((cell) => cell.trim());
}

function isTableDivider(line: string): boolean {
  const cells = splitTableRow(line);
  return cells.length > 1 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.replace(/\s+/g, "")));
}

function isTableStart(lines: string[], index: number): boolean {
  return lines[index]?.includes("|") === true && isTableDivider(lines[index + 1] ?? "");
}

function listMatch(line: string): RegExpMatchArray | null {
  return line.match(/^(\s*)([-*+]|\d+[.)])\s+(.+)$/);
}

function startsBlock(lines: string[], index: number): boolean {
  const line = lines[index] ?? "";
  const trimmed = line.trim();
  return (
    trimmed === "" ||
    isFence(line) ||
    isTableStart(lines, index) ||
    listMatch(line) !== null ||
    trimmed.startsWith(">") ||
    /^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)
  );
}

function parseBlocks(text: string): Block[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();

    if (trimmed === "") {
      i += 1;
      continue;
    }

    if (isFence(line)) {
      const lang = trimmed.slice(3).trim() || undefined;
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !isFence(lines[i] ?? "")) {
        body.push(lines[i] ?? "");
        i += 1;
      }
      if (i < lines.length) i += 1;
      blocks.push({ type: "code", lang, text: body.join("\n") });
      continue;
    }

    if (isTableStart(lines, i)) {
      const header = splitTableRow(lines[i] ?? "");
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && (lines[i] ?? "").includes("|") && (lines[i] ?? "").trim() !== "") {
        rows.push(splitTableRow(lines[i] ?? ""));
        i += 1;
      }
      blocks.push({ type: "table", header, rows });
      continue;
    }

    const match = listMatch(line);
    if (match) {
      const ordered = /^\d+[.)]$/.test(match[2] ?? "");
      const items: string[] = [];
      while (i < lines.length) {
        const current = listMatch(lines[i] ?? "");
        if (!current || /^\d+[.)]$/.test(current[2] ?? "") !== ordered) break;
        items.push(current[3] ?? "");
        i += 1;
      }
      blocks.push({ type: "list", ordered, items });
      continue;
    }

    if (trimmed.startsWith(">")) {
      const quote: string[] = [];
      while (i < lines.length && (lines[i] ?? "").trim().startsWith(">")) {
        quote.push((lines[i] ?? "").trim().replace(/^>\s?/, ""));
        i += 1;
      }
      blocks.push({ type: "quote", text: quote.join("\n") });
      continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      blocks.push({ type: "rule" });
      i += 1;
      continue;
    }

    const paragraph: string[] = [];
    while (i < lines.length && !startsBlock(lines, i)) {
      paragraph.push(lines[i] ?? "");
      i += 1;
    }
    blocks.push({ type: "paragraph", text: paragraph.join("\n") });
  }

  return blocks;
}

function safeHref(href: string): string | null {
  if (/^(https?:|mailto:)/i.test(href)) return href;
  return null;
}

function findLink(text: string, from: number): { index: number; end: number; label: string; href: string } | null {
  const start = text.indexOf("[", from);
  if (start === -1) return null;
  const labelEnd = text.indexOf("](", start + 1);
  if (labelEnd === -1) return null;
  const hrefEnd = text.indexOf(")", labelEnd + 2);
  if (hrefEnd === -1) return null;
  return {
    index: start,
    end: hrefEnd + 1,
    label: text.slice(start + 1, labelEnd),
    href: text.slice(labelEnd + 2, hrefEnd),
  };
}

function renderInline(text: string, keyPrefix = "i"): ReactNode[] {
  const nodes: ReactNode[] = [];
  let cursor = 0;

  while (cursor < text.length) {
    const codeStart = text.indexOf("`", cursor);
    const boldStart = text.indexOf("**", cursor);
    const link = findLink(text, cursor);
    const candidates = [
      codeStart === -1 ? null : { type: "code" as const, index: codeStart },
      boldStart === -1 ? null : { type: "bold" as const, index: boldStart },
      link ? { type: "link" as const, index: link.index, link } : null,
    ]
      .filter((item): item is NonNullable<typeof item> => item !== null)
      .sort((a, b) => a.index - b.index);

    const next = candidates[0];
    if (!next) {
      nodes.push(text.slice(cursor));
      break;
    }

    if (next.index > cursor) {
      nodes.push(text.slice(cursor, next.index));
    }

    if (next.type === "code") {
      const end = text.indexOf("`", next.index + 1);
      if (end === -1) {
        nodes.push(text.slice(next.index));
        break;
      }
      nodes.push(
        <code
          key={`${keyPrefix}-code-${next.index}`}
          className="bg-muted text-foreground rounded px-1 py-0.5 font-mono text-[0.92em]"
        >
          {text.slice(next.index + 1, end)}
        </code>,
      );
      cursor = end + 1;
      continue;
    }

    if (next.type === "bold") {
      const end = text.indexOf("**", next.index + 2);
      if (end === -1) {
        nodes.push(text.slice(next.index));
        break;
      }
      nodes.push(
        <strong key={`${keyPrefix}-bold-${next.index}`} className="text-foreground font-semibold">
          {renderInline(text.slice(next.index + 2, end), `${keyPrefix}-bold-${next.index}`)}
        </strong>,
      );
      cursor = end + 2;
      continue;
    }

    const href = safeHref(next.link.href);
    if (!href) {
      nodes.push(text.slice(next.index, next.link.end));
    } else {
      nodes.push(
        <a
          key={`${keyPrefix}-link-${next.index}`}
          href={href}
          target="_blank"
          rel="noreferrer"
          className="text-foreground underline underline-offset-2"
        >
          {renderInline(next.link.label, `${keyPrefix}-link-${next.index}`)}
        </a>,
      );
    }
    cursor = next.link.end;
  }

  return nodes;
}

function TurnTextBlocks({ text }: { text: string }) {
  const blocks = parseBlocks(text);
  return (
    <div className="space-y-3 text-sm leading-6 break-words [overflow-wrap:anywhere]">
      {blocks.map((block, index) => {
        if (block.type === "paragraph") {
          return (
            <p key={index} className="whitespace-pre-wrap">
              {renderInline(block.text, `p-${index}`)}
            </p>
          );
        }
        if (block.type === "code") {
          return (
            <pre
              key={index}
              className="bg-muted/70 text-foreground overflow-x-auto rounded-lg border px-3 py-2 font-mono text-xs leading-5 whitespace-pre"
            >
              <code>{block.text}</code>
            </pre>
          );
        }
        if (block.type === "table") {
          return (
            <div key={index} className="-mx-1 overflow-x-auto py-1">
              <table className="w-full min-w-max border-separate border-spacing-0 text-left text-[13px] leading-5">
                <thead>
                  <tr>
                    {block.header.map((cell, ci) => (
                      <th
                        key={ci}
                        className="bg-muted/70 border-border border-y border-l px-2 py-1.5 font-semibold first:rounded-l-md last:rounded-r-md last:border-r"
                      >
                        {renderInline(cell, `t-${index}-h-${ci}`)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {block.rows.map((row, ri) => (
                    <tr key={ri}>
                      {block.header.map((_, ci) => (
                        <td
                          key={ci}
                          className="border-border border-b border-l px-2 py-1.5 align-top last:border-r"
                        >
                          {renderInline(row[ci] ?? "", `t-${index}-${ri}-${ci}`)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        }
        if (block.type === "list") {
          const ListTag = block.ordered ? "ol" : "ul";
          return (
            <ListTag
              key={index}
              className={block.ordered ? "list-decimal space-y-1 pl-5" : "list-disc space-y-1 pl-5"}
            >
              {block.items.map((item, ii) => (
                <li key={ii}>{renderInline(item, `l-${index}-${ii}`)}</li>
              ))}
            </ListTag>
          );
        }
        if (block.type === "quote") {
          return (
            <blockquote key={index} className="border-border text-muted-foreground border-l-2 pl-3 whitespace-pre-wrap">
              {renderInline(block.text, `q-${index}`)}
            </blockquote>
          );
        }
        return <hr key={index} className="border-border" />;
      })}
    </div>
  );
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
    return <TurnTextBlocks text={text} />;
  }
  // display 유틸은 라벨별로만 지정 — 공용 문자열에 inline-block 을 두면 hidden 과
  // 같은 우선순위로 충돌해 두 라벨이 동시에 보인다.
  const link =
    "text-muted-foreground hover:text-foreground mt-1 cursor-pointer text-xs font-medium select-none";
  return (
    <div>
      <input type="checkbox" id={id} className="peer sr-only" />
      <div className="max-h-36 overflow-hidden peer-checked:max-h-none">
        <TurnTextBlocks text={text} />
      </div>
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
