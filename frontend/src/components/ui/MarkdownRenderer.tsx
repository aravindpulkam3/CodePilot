import React, { useState } from "react";
import { Copy, Check } from "lucide-react";

type Tone = "dark" | "auto";

interface MarkdownRendererProps {
  content: string;
  className?: string;
  /**
   * "dark" (default) preserves the original, unchanged hardcoded-dark
   * rendering that Q&A/Interview/Review chat bubbles already rely on.
   * "auto" renders on the app's light/dark design tokens instead — opt in
   * only where the surrounding surface isn't a dedicated dark bubble (e.g.
   * the PR Review AI panel and inline diff annotations).
   */
  tone?: Tone;
}

const TONE_CLASSES: Record<Tone, {
  heading: string;
  paragraph: string;
  listItem: string;
  blockquote: string;
  inlineCode: string;
  bold: string;
  italic: string;
  codeBlockContainer: string;
  codeBlockHeader: string;
  codeBlockHeaderLabel: string;
  codeBlockCopyBtn: string;
  codeBlockPre: string;
}> = {
  dark: {
    heading: "text-slate-100",
    paragraph: "text-slate-200",
    listItem: "text-slate-300",
    blockquote: "text-slate-300 bg-signal-500/5 border-signal-500/80",
    inlineCode: "bg-slate-800 text-teal-300 border border-slate-700/80",
    bold: "text-slate-100",
    italic: "text-slate-200",
    codeBlockContainer: "border-slate-700/60 bg-slate-950",
    codeBlockHeader: "bg-slate-900/90 border-slate-800 text-slate-400",
    codeBlockHeaderLabel: "text-slate-300",
    codeBlockCopyBtn: "bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white",
    codeBlockPre: "text-slate-100",
  },
  auto: {
    heading: "text-ink-light dark:text-ink-dark",
    paragraph: "text-ink-light dark:text-ink-dark",
    listItem: "text-ink-light dark:text-ink-dark",
    blockquote: "text-ink-light dark:text-ink-dark bg-signal-500/5 border-signal-500/80",
    inlineCode: "bg-black/[.04] dark:bg-white/[.06] text-signal-700 dark:text-signal-300 border border-border-light dark:border-border-dark",
    bold: "text-ink-light dark:text-ink-dark",
    italic: "text-ink-light dark:text-ink-dark",
    codeBlockContainer: "border-border-light dark:border-slate-700/60 bg-slate-50 dark:bg-slate-950",
    codeBlockHeader: "bg-black/[.03] dark:bg-slate-900/90 border-border-light dark:border-slate-800 text-muted-light dark:text-slate-400",
    codeBlockHeaderLabel: "text-ink-light dark:text-slate-300",
    codeBlockCopyBtn: "bg-black/[.05] hover:bg-black/[.08] dark:bg-slate-800 dark:hover:bg-slate-700 text-muted-light hover:text-ink-light dark:text-slate-300 dark:hover:text-white",
    codeBlockPre: "text-ink-light dark:text-slate-100",
  },
};

export const MarkdownRenderer: React.FC<MarkdownRendererProps> = ({
  content,
  className = "",
  tone = "dark",
}) => {
  if (!content) return null;

  const t = TONE_CLASSES[tone];

  // Split content by code blocks ```lang ... ```
  const parts = content.split(/(```[\s\S]*?```)/g);

  return (
    <div className={`space-y-3 leading-relaxed text-sm ${className}`}>
      {parts.map((part, index) => {
        if (part.startsWith("```")) {
          return <CodeBlock key={index} rawBlock={part} t={t} />;
        }
        return <FormattedParagraphs key={index} text={part} t={t} />;
      })}
    </div>
  );
};

type ToneClasses = (typeof TONE_CLASSES)[Tone];

interface CodeBlockProps {
  rawBlock: string;
  t: ToneClasses;
}

const CodeBlock: React.FC<CodeBlockProps> = ({ rawBlock, t }) => {
  const [copied, setCopied] = useState(false);

  // Extract language and code
  const match = rawBlock.match(/^```(\w+)?\n?([\s\S]*?)```$/);
  const language = match ? match[1] || "code" : "code";
  const code = match ? match[2].trimEnd() : rawBlock.replace(/^```|```$/g, "");

  const handleCopy = () => {
    navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className={`relative group my-3 rounded-lg overflow-hidden border shadow-md ${t.codeBlockContainer}`}>
      {/* Code Header */}
      <div className={`flex items-center justify-between px-3.5 py-1.5 border-b text-[11px] font-mono ${t.codeBlockHeader}`}>
        <span className={`font-semibold uppercase tracking-wider ${t.codeBlockHeaderLabel}`}>
          {language}
        </span>
        <button
          onClick={handleCopy}
          type="button"
          className={`flex items-center gap-1.5 px-2 py-0.5 rounded text-xs transition-colors ${t.codeBlockCopyBtn}`}
          title="Copy code"
        >
          {copied ? (
            <>
              <Check className="h-3.5 w-3.5 text-emerald-400" />
              <span className="text-emerald-400 font-sans">Copied!</span>
            </>
          ) : (
            <>
              <Copy className="h-3.5 w-3.5" />
              <span className="font-sans">Copy</span>
            </>
          )}
        </button>
      </div>

      {/* Code Content */}
      <pre className={`p-3.5 text-xs font-mono overflow-x-auto leading-relaxed thin-scrollbar ${t.codeBlockPre}`}>
        <code>{code}</code>
      </pre>
    </div>
  );
};

interface FormattedParagraphsProps {
  text: string;
  t: ToneClasses;
}

const FormattedParagraphs: React.FC<FormattedParagraphsProps> = ({ text, t }) => {
  if (!text.trim()) return null;

  const lines = text.split("\n");
  const renderedElements: React.ReactNode[] = [];
  let currentListItems: React.ReactNode[] = [];
  let isNumberedList = false;

  const flushList = () => {
    if (currentListItems.length > 0) {
      if (isNumberedList) {
        renderedElements.push(
          <ol key={`ol-${renderedElements.length}`} className="list-decimal pl-5 space-y-1 my-2">
            {currentListItems}
          </ol>
        );
      } else {
        renderedElements.push(
          <ul key={`ul-${renderedElements.length}`} className="list-disc pl-5 space-y-1 my-2">
            {currentListItems}
          </ul>
        );
      }
      currentListItems = [];
    }
  };

  lines.forEach((line, idx) => {
    const trimmed = line.trim();

    // Headings
    if (trimmed.startsWith("### ")) {
      flushList();
      renderedElements.push(
        <h4 key={idx} className={`text-sm font-bold mt-3 mb-1 ${t.heading}`}>
          {formatInline(trimmed.slice(4), t)}
        </h4>
      );
      return;
    }
    if (trimmed.startsWith("## ")) {
      flushList();
      renderedElements.push(
        <h3 key={idx} className={`text-base font-bold mt-4 mb-1.5 ${t.heading}`}>
          {formatInline(trimmed.slice(3), t)}
        </h3>
      );
      return;
    }
    if (trimmed.startsWith("# ")) {
      flushList();
      renderedElements.push(
        <h2 key={idx} className={`text-lg font-bold mt-4 mb-2 ${t.heading}`}>
          {formatInline(trimmed.slice(2), t)}
        </h2>
      );
      return;
    }

    // Bullet list
    if (trimmed.startsWith("- ") || trimmed.startsWith("* ")) {
      if (isNumberedList) flushList();
      isNumberedList = false;
      currentListItems.push(
        <li key={idx} className={t.listItem}>
          {formatInline(trimmed.slice(2), t)}
        </li>
      );
      return;
    }

    // Numbered list
    const numMatch = trimmed.match(/^(\d+)\.\s+(.*)$/);
    if (numMatch) {
      if (!isNumberedList && currentListItems.length > 0) flushList();
      isNumberedList = true;
      currentListItems.push(
        <li key={idx} className={t.listItem}>
          {formatInline(numMatch[2], t)}
        </li>
      );
      return;
    }

    // Blockquote
    if (trimmed.startsWith("> ")) {
      flushList();
      renderedElements.push(
        <blockquote
          key={idx}
          className={`border-l-2 pl-3 py-1 my-2 rounded-r text-xs italic ${t.blockquote}`}
        >
          {formatInline(trimmed.slice(2), t)}
        </blockquote>
      );
      return;
    }

    // Regular line
    flushList();
    if (trimmed) {
      renderedElements.push(
        <p key={idx} className={`my-1.5 ${t.paragraph}`}>
          {formatInline(line, t)}
        </p>
      );
    }
  });

  flushList();

  return <>{renderedElements}</>;
};

// Helper for inline markdown: `code`, **bold**, *italic*
function formatInline(text: string, t: ToneClasses): React.ReactNode {
  // Regex splitting inline code, bold, italic
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*)/g);

  return parts.map((part, index) => {
    if (part.startsWith("`") && part.endsWith("`") && part.length > 1) {
      return (
        <code
          key={index}
          className={`px-1.5 py-0.5 mx-0.5 rounded font-mono text-[12px] font-medium ${t.inlineCode}`}
        >
          {part.slice(1, -1)}
        </code>
      );
    }
    if (part.startsWith("**") && part.endsWith("**") && part.length > 3) {
      return (
        <strong key={index} className={`font-semibold ${t.bold}`}>
          {part.slice(2, -2)}
        </strong>
      );
    }
    if (part.startsWith("*") && part.endsWith("*") && part.length > 2) {
      return (
        <em key={index} className={`italic ${t.italic}`}>
          {part.slice(1, -1)}
        </em>
      );
    }
    return part;
  });
}
