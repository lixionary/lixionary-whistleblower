import React from "react";

function renderInline(text: string): React.ReactNode[] {
  // Regex to match inline markdown: bold, italic, code, safe links
  const inlineRegex =
    /(\*\*[^*]+?\*\*|__[^*]+?__|\*[^*]+?\*|_[^_]+?_|`[^`]+?`|\[[^\]]+?\]\((?:https?:\/\/[^\s)]+)\))/g;
  const parts = text.split(inlineRegex);

  return parts.map((part, index) => {
    if (!part) return null;
    if (
      (part.startsWith("**") && part.endsWith("**")) ||
      (part.startsWith("__") && part.endsWith("__"))
    ) {
      return <strong key={index}>{renderInline(part.slice(2, -2))}</strong>;
    }
    if (
      (part.startsWith("*") && part.endsWith("*")) ||
      (part.startsWith("_") && part.endsWith("_"))
    ) {
      return <em key={index}>{renderInline(part.slice(1, -1))}</em>;
    }
    if (part.startsWith("`") && part.endsWith("`")) {
      return <code key={index}>{part.slice(1, -1)}</code>;
    }
    const linkMatch = part.match(/^\[([^\]]+?)\]\((https?:\/\/[^\s)]+)\)$/);
    if (linkMatch) {
      const [, label, url] = linkMatch;
      return (
        <a
          key={index}
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="underline text-accent hover:text-accent-active"
        >
          {label}
        </a>
      );
    }
    return <React.Fragment key={index}>{part}</React.Fragment>;
  });
}

export function SafeMarkdown({
  content,
  className = "",
}: {
  content: string;
  className?: string;
}) {
  if (!content) return null;

  // Normalize line endings
  const raw = content.replace(/\r\n/g, "\n");

  // First handle multi-line code blocks
  const sections: { type: "code" | "text"; content: string; lang?: string }[] =
    [];
  const codeBlockRegex = /```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = codeBlockRegex.exec(raw)) !== null) {
    if (match.index > lastIndex) {
      sections.push({
        type: "text",
        content: raw.slice(lastIndex, match.index),
      });
    }
    sections.push({
      type: "code",
      lang: match[1] || "",
      content: match[2] ?? "",
    });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < raw.length) {
    sections.push({ type: "text", content: raw.slice(lastIndex) });
  }

  const renderedBlocks: React.ReactNode[] = [];
  let blockKey = 0;

  for (const section of sections) {
    if (section.type === "code") {
      renderedBlocks.push(
        <pre key={blockKey++}>
          <code>{section.content.replace(/\n$/, "")}</code>
        </pre>,
      );
      continue;
    }

    // Split text sections into paragraph/block groups separated by double newlines
    const rawBlocks = section.content.split(/\n\s*\n/);

    for (const rawBlock of rawBlocks) {
      const trimmed = rawBlock.trim();
      if (!trimmed) continue;

      const lines = trimmed.split("\n").map((l) => l.trimEnd());

      // Heading 1-4
      if (lines.length === 1 && /^#{1,4}\s+/.test(lines[0]!)) {
        const hMatch = lines[0]!.match(/^(#{1,4})\s+(.+)$/);
        if (hMatch) {
          const level = hMatch[1]!.length;
          const text = hMatch[2]!;
          if (level === 1) {
            renderedBlocks.push(
              <h2 key={blockKey++} className="font-semibold text-lg mt-3 mb-1">
                {renderInline(text)}
              </h2>,
            );
          } else if (level === 2) {
            renderedBlocks.push(
              <h3 key={blockKey++} className="font-semibold text-base mt-3 mb-1">
                {renderInline(text)}
              </h3>,
            );
          } else {
            renderedBlocks.push(
              <h4 key={blockKey++} className="font-semibold text-sm mt-2 mb-1">
                {renderInline(text)}
              </h4>,
            );
          }
          continue;
        }
      }

      // Blockquote
      if (lines.every((l) => l.startsWith("> ") || l === ">")) {
        const quoteText = lines
          .map((l) => l.replace(/^>\s?/, ""))
          .join("\n");
        renderedBlocks.push(
          <blockquote
            key={blockKey++}
            className="border-l-2 border-line pl-3 my-2 text-muted italic"
          >
            {renderInline(quoteText)}
          </blockquote>,
        );
        continue;
      }

      // Unordered list
      if (lines.every((l) => /^[-*]\s+/.test(l))) {
        renderedBlocks.push(
          <ul key={blockKey++} className="list-disc pl-5 my-2 space-y-1">
            {lines.map((l, i) => (
              <li key={i}>{renderInline(l.replace(/^[-*]\s+/, ""))}</li>
            ))}
          </ul>,
        );
        continue;
      }

      // Ordered list
      if (lines.every((l) => /^\d+\.\s+/.test(l))) {
        renderedBlocks.push(
          <ol key={blockKey++} className="list-decimal pl-5 my-2 space-y-1">
            {lines.map((l, i) => (
              <li key={i}>{renderInline(l.replace(/^\d+\.\s+/, ""))}</li>
            ))}
          </ol>,
        );
        continue;
      }

      // Standard paragraph with line breaks
      renderedBlocks.push(
        <p key={blockKey++} className="my-1.5 leading-relaxed">
          {lines.map((line, lineIndex) => (
            <React.Fragment key={lineIndex}>
              {lineIndex > 0 && <br />}
              {renderInline(line)}
            </React.Fragment>
          ))}
        </p>,
      );
    }
  }

  return (
    <div className={`markdown-content ${className}`.trim()}>
      {renderedBlocks}
    </div>
  );
}
