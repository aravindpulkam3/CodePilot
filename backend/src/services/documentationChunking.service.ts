import crypto from "crypto";
import path from "path";
import { ChunkMetadata } from "./astChunking.service.js";

/**
 * Structure-aware Markdown chunker for documentation files (README today).
 *
 * Emits the same `ChunkMetadata` shape the AST chunker produces, so every
 * downstream stage — content-hash delta detection, embedding, insert/delete,
 * orphan cleanup — works unchanged. There is no separate documentation
 * pipeline and no separate table.
 *
 * The guiding rule is: split on Markdown STRUCTURE, never on raw line
 * offsets. A README's value lives in exactly the things an arbitrary cut
 * destroys — a truncated `docker compose` invocation, half a config table, a
 * setup sequence severed mid-step. A chunk like that retrieves confidently
 * and is actively wrong, which is worse than not retrieving at all. Raw line
 * splitting survives only as a last resort, applied to a single indivisible
 * block that is oversized on its own (see `splitBlockByLines`).
 */

// maxLines mirrors CHUNK_LIMITS in astChunking.service.ts. maxChars is a
// conservative proxy for gemini-embedding-001's 2048-token input limit —
// nothing in this codebase counts tokens, and the line cap alone does not
// bound dense prose. It errs small for non-Latin scripts, which is the safe
// direction.
const DOC_CHUNK_LIMITS = {
  maxLines: 200,
  maxChars: 6000,
  overlapLines: 10,
};

// Bounds the sequential-scan cost a single pathological document can add.
// Dropping from the tail keeps the overview and setup sections — the
// highest-value ones — and discards trailing changelog/appendix material.
const MAX_CHUNKS_PER_DOCUMENT = 40;

const INTRO_SECTION_NAME = "(intro)";

type BlockKind = "heading" | "fence" | "table" | "list" | "paragraph";

interface Block {
  kind: BlockKind;
  lines: string[];
  /** 1-based, inclusive. */
  startLine: number;
  endLine: number;
  /** Heading blocks only. */
  level?: number;
  text?: string;
}

interface Section {
  /** Full heading breadcrumb, e.g. "Getting Started > Docker". */
  breadcrumb: string;
  blocks: Block[];
}

const FENCE_OPEN = /^\s{0,3}(`{3,}|~{3,})(.*)$/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const LIST_ITEM = /^\s*([-*+]|\d+[.)])\s+/;
const TABLE_SEPARATOR = /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/;

export class DocumentationChunkingService {
  private hash(content: string): string {
    return crypto.createHash("sha256").update(content).digest("hex");
  }

  // ------------------------------------------------------------ Pass 1
  /**
   * Tokenizes the source into structural blocks. Fenced code, tables and
   * list groups come out as single atomic blocks that later passes will
   * never split internally.
   */
  private tokenizeBlocks(source: string): Block[] {
    const lines = source.split("\n");
    const blocks: Block[] = [];
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];

      if (line.trim() === "") {
        i++;
        continue;
      }

      // --- Fenced code: atomic. Consumed first so that a "# comment" or a
      // "|" table-looking line INSIDE a fence can never be mistaken for a
      // heading or a table row.
      const fenceMatch = line.match(FENCE_OPEN);
      if (fenceMatch) {
        const marker = fenceMatch[1][0];
        const markerLen = fenceMatch[1].length;
        const start = i;
        i++;
        while (i < lines.length) {
          const closeMatch = lines[i].match(/^\s{0,3}(`{3,}|~{3,})\s*$/);
          if (closeMatch && closeMatch[1][0] === marker && closeMatch[1].length >= markerLen) {
            i++;
            break;
          }
          i++;
        }
        blocks.push({
          kind: "fence",
          lines: lines.slice(start, i),
          startLine: start + 1,
          endLine: i,
        });
        continue;
      }

      // --- Heading (only reachable outside a fence).
      const headingMatch = line.match(HEADING);
      if (headingMatch) {
        blocks.push({
          kind: "heading",
          lines: [line],
          startLine: i + 1,
          endLine: i + 1,
          level: headingMatch[1].length,
          text: headingMatch[2].trim(),
        });
        i++;
        continue;
      }

      // --- Table: a header row followed by a separator row. Atomic.
      if (
        line.includes("|") &&
        i + 1 < lines.length &&
        lines[i + 1].includes("|") &&
        TABLE_SEPARATOR.test(lines[i + 1])
      ) {
        const start = i;
        i += 2;
        while (i < lines.length && lines[i].trim() !== "" && lines[i].includes("|")) {
          i++;
        }
        blocks.push({
          kind: "table",
          lines: lines.slice(start, i),
          startLine: start + 1,
          endLine: i,
        });
        continue;
      }

      // --- List group: contiguous items plus indented continuations, and
      // blank lines that are followed by another item (loose lists).
      if (LIST_ITEM.test(line)) {
        const start = i;
        i++;
        while (i < lines.length) {
          const cur = lines[i];
          if (LIST_ITEM.test(cur) || /^\s+\S/.test(cur)) {
            i++;
            continue;
          }
          if (cur.trim() === "") {
            // Only continue the group if another item follows the blank run.
            let lookahead = i;
            while (lookahead < lines.length && lines[lookahead].trim() === "") lookahead++;
            if (lookahead < lines.length && LIST_ITEM.test(lines[lookahead])) {
              i = lookahead;
              continue;
            }
          }
          break;
        }
        blocks.push({
          kind: "list",
          lines: lines.slice(start, i),
          startLine: start + 1,
          endLine: i,
        });
        continue;
      }

      // --- Paragraph: run to the next blank line or structural boundary.
      const start = i;
      while (i < lines.length) {
        const cur = lines[i];
        if (
          cur.trim() === "" ||
          HEADING.test(cur) ||
          FENCE_OPEN.test(cur) ||
          LIST_ITEM.test(cur)
        ) {
          break;
        }
        i++;
      }
      blocks.push({
        kind: "paragraph",
        lines: lines.slice(start, i),
        startLine: start + 1,
        endLine: i,
      });
    }

    return blocks;
  }

  // ------------------------------------------------------------ Pass 2
  /**
   * Groups blocks into sections under their heading, preserving the
   * heading -> content relationship and the full breadcrumb path.
   */
  private assembleSections(blocks: Block[]): Section[] {
    const sections: Section[] = [];
    const headingStack: { level: number; text: string }[] = [];
    let current: Section = { breadcrumb: INTRO_SECTION_NAME, blocks: [] };

    for (const block of blocks) {
      if (block.kind === "heading") {
        if (current.blocks.length > 0) sections.push(current);

        while (headingStack.length > 0 && headingStack[headingStack.length - 1].level >= block.level!) {
          headingStack.pop();
        }
        headingStack.push({ level: block.level!, text: block.text! });

        current = {
          breadcrumb: headingStack.map((h) => h.text).join(" > "),
          blocks: [block],
        };
        continue;
      }
      current.blocks.push(block);
    }

    if (current.blocks.length > 0) sections.push(current);
    return sections;
  }

  // ------------------------------------------------------------ Pass 3
  private blockText(blocks: Block[]): string {
    return blocks.map((b) => b.lines.join("\n")).join("\n\n");
  }

  /**
   * True when a section has actual body content, not just its own heading.
   *
   * A heading whose content lives entirely in its child sections ("## Getting
   * Started" followed immediately by "### Prerequisites") produces a section
   * containing nothing but the heading line. Embedding that costs an API
   * call, a stored row, and sequential-scan time on every future search, and
   * returns text the children already carry in their own breadcrumbs. Same
   * for decorative headers like "## Screenshots" above a bare image link.
   *
   * The intro section has no heading block at all, so it is kept whenever it
   * has any content — which is what the `kind !== "heading"` test gives us.
   */
  private hasBody(section: Section): boolean {
    return section.blocks.some(
      (b) => b.kind !== "heading" && b.lines.join("").trim().length > 0,
    );
  }

  private fits(blocks: Block[]): boolean {
    const lineCount = blocks.reduce((n, b) => n + b.lines.length, 0);
    if (lineCount > DOC_CHUNK_LIMITS.maxLines) return false;
    return this.blockText(blocks).length <= DOC_CHUNK_LIMITS.maxChars;
  }

  /**
   * LAST RESORT — the only place a raw line cut happens. Reached only when a
   * single indivisible block (typically one enormous code fence) blows the
   * caps on its own. Overlap keeps logic straddling the boundary readable in
   * both parts, matching the AST chunker's behaviour.
   */
  private splitBlockByLines(block: Block): Block[] {
    const parts: Block[] = [];
    let cursor = 0;

    while (cursor < block.lines.length) {
      const taken: string[] = [];
      let chars = 0;
      let idx = cursor;

      while (idx < block.lines.length) {
        const nextLen = block.lines[idx].length + 1;
        if (taken.length >= DOC_CHUNK_LIMITS.maxLines) break;
        if (taken.length > 0 && chars + nextLen > DOC_CHUNK_LIMITS.maxChars) break;
        taken.push(block.lines[idx]);
        chars += nextLen;
        idx++;
      }

      parts.push({
        kind: block.kind,
        lines: taken,
        startLine: block.startLine + cursor,
        endLine: block.startLine + cursor + taken.length - 1,
      });

      if (idx >= block.lines.length) break;
      cursor = Math.max(idx - DOC_CHUNK_LIMITS.overlapLines, cursor + 1);
    }

    return parts;
  }

  /**
   * Packs a section's blocks into as few parts as possible, splitting only
   * at block boundaries.
   */
  private packSection(section: Section): Block[][] {
    if (this.fits(section.blocks)) return [section.blocks];

    const parts: Block[][] = [];
    let currentPart: Block[] = [];

    for (const block of section.blocks) {
      if (currentPart.length > 0 && !this.fits([...currentPart, block])) {
        parts.push(currentPart);
        currentPart = [];
      }

      if (!this.fits([block])) {
        // Indivisible and oversized on its own.
        if (currentPart.length > 0) {
          parts.push(currentPart);
          currentPart = [];
        }
        for (const piece of this.splitBlockByLines(block)) parts.push([piece]);
        continue;
      }

      currentPart.push(block);
    }

    if (currentPart.length > 0) parts.push(currentPart);
    return parts;
  }

  private buildChunk(
    filePath: string,
    breadcrumb: string,
    blocks: Block[],
    partIndex: number,
    partTotal: number,
  ): ChunkMetadata {
    const sectionName = partTotal > 1 ? `${breadcrumb} (part ${partIndex}/${partTotal})` : breadcrumb;

    // Self-describing header, same idea as the AST chunker's: a chunk
    // retrieved in isolation still states where it came from, and the
    // breadcrumb is repeated on every part of a split section.
    const header = [
      `// File: ${filePath}`,
      `// Type: documentation`,
      `// Section: ${breadcrumb}`,
    ].join("\n");

    const content = `${header}\n${this.blockText(blocks)}`.trim();

    return {
      file_path: filePath,
      language: "Markdown",
      symbol_type: "documentation",
      symbol_name: sectionName,
      start_line: blocks[0].startLine,
      end_line: blocks[blocks.length - 1].endLine,
      content,
      content_hash: this.hash(content),
      chunk_index: partTotal > 1 ? partIndex : undefined,
      chunk_total: partTotal > 1 ? partTotal : undefined,
    };
  }

  /**
   * Chunks a documentation file. Mirrors `astChunker.chunkFile`'s contract:
   * same return shape, same hashing scheme.
   *
   * IMPORTANT: never returns [] for non-empty input. The indexer treats an
   * empty chunk list as "delete every existing row for this path"
   * (repositoryIndex.service.ts), so returning [] on a document that failed
   * to section would silently erase it from the index.
   */
  public async chunkDocument(filePath: string, source: string): Promise<ChunkMetadata[]> {
    if (!source || source.trim().length === 0) return [];

    try {
      const blocks = this.tokenizeBlocks(source);
      const allSections = this.assembleSections(blocks);

      // Drop heading-only sections. Safe with respect to the never-return-[]
      // contract: if this filters everything out (a document that is nothing
      // but headings), `chunks` ends up empty and the whole-file fallback
      // below still produces a chunk.
      const sections = allSections.filter((s) => this.hasBody(s));
      const skipped = allSections.length - sections.length;
      if (skipped > 0) {
        console.log(
          `[Doc Chunker] ${filePath}: skipped ${skipped} heading-only section(s) ` +
            `(${allSections
              .filter((s) => !this.hasBody(s))
              .map((s) => `"${s.breadcrumb}"`)
              .join(", ")}) — no body to embed.`,
        );
      }

      const chunks: ChunkMetadata[] = [];
      for (const section of sections) {
        const parts = this.packSection(section);
        parts.forEach((partBlocks, idx) => {
          if (partBlocks.length === 0) return;
          chunks.push(
            this.buildChunk(filePath, section.breadcrumb, partBlocks, idx + 1, parts.length),
          );
        });
      }

      // Whole-file fallback: sectioning produced nothing usable but the file
      // has content. Better a coarse chunk than a silent index deletion.
      if (chunks.length === 0) {
        const allLines = source.split("\n");
        const wholeFile: Block = {
          kind: "paragraph",
          lines: allLines,
          startLine: 1,
          endLine: allLines.length,
        };
        const parts = this.fits([wholeFile]) ? [[wholeFile]] : this.splitBlockByLines(wholeFile).map((b) => [b]);
        parts.forEach((partBlocks, idx) => {
          chunks.push(
            this.buildChunk(filePath, path.basename(filePath), partBlocks, idx + 1, parts.length),
          );
        });
      }

      // De-duplicate by content_hash. repository_embeddings has
      // UNIQUE(repository_id, file_path, content_hash) but the INSERT has no
      // ON CONFLICT clause, so two identical sections in one document (a
      // repeated "### Example" block, say) would raise a unique violation,
      // roll back the whole chunk transaction, and flip the repo to FAILED.
      const seen = new Set<string>();
      const deduped = chunks.filter((c) => {
        if (seen.has(c.content_hash)) return false;
        seen.add(c.content_hash);
        return true;
      });

      if (deduped.length > MAX_CHUNKS_PER_DOCUMENT) {
        console.warn(
          `[Doc Chunker] ${filePath} produced ${deduped.length} chunks; keeping the first ${MAX_CHUNKS_PER_DOCUMENT}.`,
        );
        return deduped.slice(0, MAX_CHUNKS_PER_DOCUMENT);
      }

      return deduped;
    } catch (error) {
      console.error(`[Doc Chunker] Failed to chunk ${filePath}:`, error);
      // Deliberately NOT returning [] — see the contract note above. A parse
      // failure must not be indistinguishable from "this file is now empty".
      throw error;
    }
  }
}

export const documentationChunker = new DocumentationChunkingService();
