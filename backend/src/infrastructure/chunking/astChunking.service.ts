import { Parser, Language, Query } from "web-tree-sitter";
import crypto from "crypto";
import path from "path";
import fs from "fs";

export interface ChunkMetadata {
  file_path: string;
  language: string;
  symbol_type: string;
  symbol_name: string;
  start_line: number;
  end_line: number;
  content: string;
  content_hash: string;
  qualified_name?: string; // e.g. "UserService.createUser" for a method
  parent_symbol?: string; // enclosing class/interface/struct name, if any
  is_exported?: boolean; // true if wrapped in an export/export default
  docstring?: string | null; // leading comment / JSDoc / decorator / docstring
  chunk_index?: number; // set when a symbol was too large and got split
  chunk_total?: number; // total number of parts for a split symbol
}

export interface FileASTMetadata {
  filePath: string;
  folderPath: string;
  language: string;
  imports: string[];
  exports: string[];
  classes: string[];
  interfaces: string[];
  functions: string[];
  decorators: string[];
  annotations: string[];
  inheritance: { child: string; parents: string[] }[];
  sourceHash: string;
}

interface LangConfig {
  name: string;
  wasmPath: string;
  query: string;
}

const LANGUAGE_REGISTRY: Record<string, LangConfig> = {
  ".ts": {
    name: "TypeScript",
    wasmPath: path.join(process.cwd(), "parsers", "tree-sitter-typescript.wasm"),
    query: `
      (function_declaration) @function
      (method_definition) @method
      (class_declaration) @class
      (interface_declaration) @interface
      (enum_declaration) @enum
      (type_alias_declaration) @type
      (variable_declarator name: (identifier) value: (arrow_function)) @function
      (variable_declarator name: (identifier) value: (function_expression)) @function
      (public_field_definition value: (arrow_function)) @method
    `,
  },
  ".tsx": {
    name: "TypeScript (React)",
    wasmPath: path.join(process.cwd(), "parsers", "tree-sitter-tsx.wasm"), // TSX uses a unique parser
    query: `
      (function_declaration) @function
      (method_definition) @method
      (class_declaration) @class
      (interface_declaration) @interface
      (enum_declaration) @enum
      (type_alias_declaration) @type
      (variable_declarator name: (identifier) value: (arrow_function)) @function
      (variable_declarator name: (identifier) value: (function_expression)) @function
      (public_field_definition value: (arrow_function)) @method
    `,
  },
  ".js": {
    name: "JavaScript",
    wasmPath: path.join(process.cwd(), "parsers", "tree-sitter-javascript.wasm"),
    query: `
      (function_declaration) @function
      (method_definition) @method
      (class_declaration) @class
      (variable_declarator name: (identifier) value: (arrow_function)) @function
      (variable_declarator name: (identifier) value: (function_expression)) @function
      (field_definition value: (arrow_function)) @method
    `,
  },
  ".jsx": {
    name: "JavaScript (React)",
    wasmPath: path.join(process.cwd(), "parsers", "tree-sitter-javascript.wasm"), // JS parser handles JSX
    query: `
      (function_declaration) @function
      (method_definition) @method
      (class_declaration) @class
      (variable_declarator name: (identifier) value: (arrow_function)) @function
      (variable_declarator name: (identifier) value: (function_expression)) @function
      (field_definition value: (arrow_function)) @method
    `,
  },
  ".py": {
    name: "Python",
    wasmPath: path.join(process.cwd(), "parsers", "tree-sitter-python.wasm"),
    query: `
      (function_definition) @function
      (class_definition) @class
    `,
  },
  ".go": {
    name: "Go",
    wasmPath: path.join(process.cwd(), "parsers", "tree-sitter-go.wasm"),
    query: `
      (function_declaration) @function
      (method_declaration) @method
      (type_declaration) @class
    `,
  },
  ".cpp": {
    name: "C++",
    wasmPath: path.join(process.cwd(), "parsers", "tree-sitter-cpp.wasm"),
    query: `
      (function_definition) @function
      (class_specifier) @class
      (struct_specifier) @class
    `,
  },
};

// Symbols larger than this (measured in non-whitespace characters) become a
// class_skeleton + independent member chunks (classes) or get recursively
// split at AST statement boundaries (everything else), instead of staying
// one chunk. Matches DOC_CHUNK_LIMITS.maxChars in documentationChunking.service.ts
// — the same category of "when to force-split" decision, kept consistent
// rather than inventing an unrelated number. Characters, not lines or
// tokens: no tokenizer is wired into this project (see embedding.service.ts
// — gemini-embedding-001 is called directly on chunk.content with no token
// counting anywhere), and non-whitespace character count is what keeps
// chunk size comparable across files/languages regardless of
// indentation/formatting style.
const CHUNK_BUDGET_CHARS = 6000;

interface SymbolMeta {
  symbolType: string;
  symbolName: string;
  qualifiedName: string;
  parentSymbol: string | null;
  isExported: boolean;
  docstring: string | null;
}

interface PartInfo {
  index: number;
  total: number;
}

interface Range {
  startIndex: number;
  endIndex: number;
  startRow: number;
  endRow: number;
}

export class AstChunkingService {
  private isInitialized = false;
  private loadedLanguages: Map<string, Language> = new Map();

  public async init() {
    if (this.isInitialized) return;
    try {
      await Parser.init();
      this.isInitialized = true;
      console.log("[AST Chunker] Web-Tree-Sitter initialized successfully.");
    } catch (error) {
      console.error("[AST Chunker] Failed to initialize Web-Tree-Sitter:", error);
      throw error;
    }
  }

  private generateHash(content: string): string {
    return crypto.createHash("sha256").update(content).digest("hex");
  }

  private async getLanguage(wasmPath: string): Promise<Language | null> {
    if (this.loadedLanguages.has(wasmPath)) {
      return this.loadedLanguages.get(wasmPath)!;
    }
    if (!fs.existsSync(wasmPath)) {//This checks the filesystem.
      console.warn(`[AST Chunker] Missing parser at: ${wasmPath}. Gracefully skipping.`);
      return null;
    }
    try {
      const language = await Language.load(wasmPath);
      this.loadedLanguages.set(wasmPath, language);
      return language;
    } catch (error) {
      console.error(`[AST Chunker] Corrupted WASM file at ${wasmPath}`, error);
      return null;
    }
  }

  // Non-whitespace character count — see CHUNK_BUDGET_CHARS above for why
  // this unit was chosen over lines or tokens.
  private measureSize(text: string): number {
    return text.replace(/\s+/g, "").length;
  }

  // --- Symbol name resolution ------------------------------------------
  // Different grammars put "name" in different places (e.g. Go wraps it in
  // a type_spec). Try the direct field first, then known special cases,
  // then fall back to the first identifier-like named child.
  private resolveSymbolName(node: any): string {
    const direct = node.childForFieldName?.("name");
    if (direct?.text) return direct.text;

    if (node.type === "type_declaration") {
      for (const child of node.namedChildren ?? []) {
        if (child.type === "type_spec") {
          const specName = child.childForFieldName?.("name");
          if (specName?.text) return specName.text;
        }
      }
    }

    for (const child of node.namedChildren ?? []) {
      if (
        child.type === "identifier" ||
        child.type === "type_identifier" ||
        child.type === "property_identifier" ||
        child.type === "field_identifier"
      ) {
        return child.text;
      }
    }

    return "anonymous";
  }

  // Walks up to find an enclosing class/interface/struct so methods can
  // carry a qualified name like "UserService.createUser" — important for
  // interview-mode context and for disambiguating same-named methods.
  // Note: this is a lexical ancestor walk, so it only finds an enclosing
  // class when the member is textually nested inside it in the AST. Go
  // methods (func (s *T) Method()) have a receiver, not lexical nesting, so
  // they never resolve a parent_symbol here — a pre-existing limitation,
  // not something this chunker introduces or attempts to fix.
  private resolveParentSymbol(node: any): string | null {
    let current = node.parent;
    let depth = 0;
    while (current && depth < 6) {
      if (
        [
          "class_declaration",
          "class_specifier",
          "struct_specifier",
          "interface_declaration",
        ].includes(current.type)
      ) {
        const name = this.resolveSymbolName(current);
        return name !== "anonymous" ? name : null;
      }
      current = current.parent;
      depth++;
    }
    return null;
  }

  // Detects export / export default wrapping so retrieval can weight public
  // API surface differently from internal helpers.
  private resolveIsExported(node: any): boolean {
    let current = node.parent;
    let depth = 0;
    while (current && depth < 3) {
      if (typeof current.type === "string" && current.type.includes("export")) return true;
      current = current.parent;
      depth++;
    }
    return false;
  }

  // Pulls in immediately preceding comments/decorators (JSDoc, Python
  // docstrings-via-decorator, TS decorators) so a chunk carries the intent
  // behind the code, not just the code itself.
  private resolveLeadingContext(node: any): { boundaryNode: any; docstring: string | null } {
    let boundaryNode = node;
    const docstringParts: string[] = [];

    // Python: decorators are siblings of the def, both wrapped in decorated_definition
    if (node.parent?.type === "decorated_definition") {
      boundaryNode = node.parent;
    }

    let sibling = boundaryNode.previousNamedSibling;
    while (sibling && (sibling.type === "comment" || sibling.type === "decorator")) {
      docstringParts.unshift(sibling.text);
      boundaryNode = sibling;
      sibling = sibling.previousNamedSibling;
    }

    return {
      boundaryNode,
      docstring: docstringParts.length ? docstringParts.join("\n") : null,
    };
  }

  // Finds a node's body/block field so we can walk its statements (AST-
  // boundary splitting) or find where its signature ends (skeleton
  // declaration/member lines). Go's struct/interface body sits one level
  // deeper, inside type_declaration -> type_spec -> type (mirrors
  // resolveSymbolName's Go special case). Returns null if the grammar has
  // nothing body-shaped here (e.g. an interface method signature with no
  // body) — callers treat that as "nothing further to recurse into."
  private findBodyField(node: any): any | null {
    if (!node) return null;
    const body = node.childForFieldName?.("body");
    if (body) return body;
    if (node.type === "type_declaration") {
      for (const child of node.namedChildren ?? []) {
        if (child.type === "type_spec") {
          const typeNode = child.childForFieldName?.("type");
          const nestedBody = typeNode?.childForFieldName?.("body");
          if (nestedBody) return nestedBody;
        }
      }
    }
    return null;
  }

  private isContained(inner: any, outer: any): boolean {
    return inner !== outer && inner.startIndex >= outer.startIndex && inner.endIndex <= outer.endIndex;
  }

  // Runs the language's tree-sitter query and returns every captured node,
  // deduped by exact span (guards two patterns matching the same node) —
  // this is the raw symbol inventory shared by chunkFile() (which decides
  // HOW to chunk them, based on size/containment) and
  // extractFileAstMetadata() (which just wants to know what's declared,
  // independent of any chunking decision).
  private captureSymbols(rootNode: any, query: Query): Array<{ node: any; symbolType: string }> {
    const matches = query.matches(rootNode);
    const seenRanges = new Set<string>();
    const out: Array<{ node: any; symbolType: string }> = [];
    for (const match of matches) {
      for (const capture of match.captures) {
        const node = capture.node;
        const rangeKey = `${node.startIndex}-${node.endIndex}`;
        if (seenRanges.has(rangeKey)) continue;
        seenRanges.add(rangeKey);
        out.push({ node, symbolType: capture.name });
      }
    }
    return out;
  }

  private buildHeader(opts: {
    filePath: string;
    languageName: string;
    symbolType: string;
    qualifiedName: string;
    isExported: boolean;
    parentSymbol?: string | null;
    partInfo?: PartInfo;
  }): string {
    return [
      `// File: ${opts.filePath}`,
      `// Language: ${opts.languageName}`,
      `// Type: ${opts.symbolType}`,
      `// Name: ${opts.qualifiedName}`,
      opts.isExported ? `// Exported: true` : null,
      opts.parentSymbol ? `// Class: ${opts.parentSymbol}` : null,
      opts.partInfo ? `// Part: ${opts.partInfo.index} of ${opts.partInfo.total}` : null,
    ]
      .filter(Boolean)
      .join("\n");
  }

  // Builds one chunk covering [rangeStart, rangeEnd) of sourceCode — used
  // both for a whole-node chunk (fits the budget) and for one AST-boundary
  // part of an oversized symbol. qualified_name stays identical across
  // parts (never suffixed); only symbol_name and the chunk_index/chunk_total
  // columns carry the part distinction, plus the header's own "// Part:"
  // line — deliberate, see the plan's note on today's ambiguous behavior.
  private buildChunkFromRange(
    rangeStart: number,
    rangeEnd: number,
    sourceCode: string,
    filePath: string,
    config: LangConfig,
    meta: SymbolMeta,
    startLine: number,
    endLine: number,
    partInfo?: PartInfo,
  ): ChunkMetadata {
    const symbolName = partInfo ? `${meta.symbolName} (part ${partInfo.index}/${partInfo.total})` : meta.symbolName;
    const header = this.buildHeader({
      filePath,
      languageName: config.name,
      symbolType: meta.symbolType,
      qualifiedName: meta.qualifiedName,
      isExported: meta.isExported,
      parentSymbol: meta.parentSymbol,
      partInfo,
    });
    const content = `${header}\n${sourceCode.slice(rangeStart, rangeEnd)}`.trim();
    return {
      file_path: filePath,
      language: config.name,
      symbol_type: meta.symbolType,
      symbol_name: symbolName,
      qualified_name: meta.qualifiedName,
      parent_symbol: meta.parentSymbol ?? undefined,
      is_exported: meta.isExported,
      docstring: meta.docstring,
      start_line: startLine,
      end_line: endLine,
      content,
      content_hash: this.generateHash(content),
      chunk_index: partInfo?.index,
      chunk_total: partInfo?.total,
    };
  }

  // Recursive greedy statement packer — this is where "merge small adjacent
  // siblings" actually happens. Packs as many whole statements as fit under
  // CHUNK_BUDGET_CHARS into each part; a single statement that alone still
  // exceeds the budget recurses one level deeper into ITS OWN body. A
  // statement with no further children to recurse into is kept whole as its
  // own oversized part rather than dropped or blindly sliced.
  private buildAstAwareParts(
    statements: any[],
    sourceCode: string,
    wholeStart: number,
    wholeEnd: number,
    wholeStartRow: number,
    wholeEndRow: number,
  ): Range[] {
    if (statements.length === 0) {
      return [{ startIndex: wholeStart, endIndex: wholeEnd, startRow: wholeStartRow, endRow: wholeEndRow }];
    }

    const groups: Range[] = [];
    let start = statements[0].startIndex;
    let end = statements[0].endIndex;
    let startRow = statements[0].startPosition.row;
    let endRow = statements[0].endPosition.row;

    for (let i = 1; i < statements.length; i++) {
      const stmt = statements[i];
      if (this.measureSize(sourceCode.slice(start, stmt.endIndex)) <= CHUNK_BUDGET_CHARS) {
        end = stmt.endIndex;
        endRow = stmt.endPosition.row;
      } else {
        groups.push({ startIndex: start, endIndex: end, startRow, endRow });
        start = stmt.startIndex;
        end = stmt.endIndex;
        startRow = stmt.startPosition.row;
        endRow = stmt.endPosition.row;
      }
    }
    groups.push({ startIndex: start, endIndex: end, startRow, endRow });

    return groups.flatMap((g) => {
      if (this.measureSize(sourceCode.slice(g.startIndex, g.endIndex)) <= CHUNK_BUDGET_CHARS) {
        return [g];
      }
      const single = statements.find((s) => s.startIndex === g.startIndex && s.endIndex === g.endIndex);
      const innerBody = single ? this.findBodyField(single) : null;
      const innerStatements: any[] = innerBody?.namedChildren ?? [];
      if (single && innerStatements.length > 0) {
        return this.buildAstAwareParts(
          innerStatements,
          sourceCode,
          single.startIndex,
          single.endIndex,
          single.startPosition.row,
          single.endPosition.row,
        );
      }
      // No further children to recurse into (e.g. one enormous single
      // expression/statement) — best-effort: keep it as one oversized part.
      return [g];
    });
  }

  // Large class -> one signature-only skeleton chunk + one independent
  // chunk per direct member (never both a full class body AND full member
  // bodies — that duplication is the bug this rework exists to fix).
  // Returns null when the class has no captured direct members to
  // skeletonize (e.g. a data-only struct with fields but no methods) — the
  // caller falls back to the generic AST-boundary split in that case, since
  // stripping "bodies" is meaningless without members to strip them from.
  private buildClassSkeletonAndMembers(
    classNode: any,
    meta: SymbolMeta,
    boundaryNode: any,
    captured: Array<{ node: any; symbolType: string }>,
    sourceCode: string,
    filePath: string,
    config: LangConfig,
  ): ChunkMetadata[] | null {
    // Direct members only — not grandchildren. A nested function inside a
    // method shouldn't be treated as a direct member of the enclosing class;
    // it's handled when that method itself gets recursed into.
    const directMembers = captured.filter(
      (c) =>
        c.node !== classNode &&
        this.isContained(c.node, classNode) &&
        !captured.some(
          (mid) =>
            mid.node !== c.node &&
            mid.node !== classNode &&
            this.isContained(mid.node, classNode) &&
            this.isContained(c.node, mid.node),
        ),
    );

    if (directMembers.length === 0) return null;

    const bodyField = this.findBodyField(classNode);
    const declarationEnd = bodyField ? bodyField.startIndex : classNode.endIndex;
    const declarationLine = sourceCode.slice(boundaryNode.startIndex, declarationEnd).trimEnd();

    const signatureLines = directMembers.map((m) => {
      const memberBody = this.findBodyField(m.node);
      const sigEnd = memberBody ? memberBody.startIndex : m.node.endIndex;
      return `  ${sourceCode.slice(m.node.startIndex, sigEnd).trimEnd()}`;
    });

    const closesWithBrace = !!bodyField && sourceCode.slice(bodyField.endIndex - 1, bodyField.endIndex) === "}";
    const skeletonBody = [declarationLine, ...signatureLines, ...(closesWithBrace ? ["}"] : [])].join("\n");

    const header = this.buildHeader({
      filePath,
      languageName: config.name,
      symbolType: "class_skeleton",
      qualifiedName: meta.qualifiedName,
      isExported: meta.isExported,
      parentSymbol: meta.parentSymbol,
    });
    const skeletonContent = `${header}\n${skeletonBody}`.trim();

    const skeleton: ChunkMetadata = {
      file_path: filePath,
      language: config.name,
      symbol_type: "class_skeleton",
      symbol_name: meta.symbolName,
      qualified_name: meta.qualifiedName,
      parent_symbol: meta.parentSymbol ?? undefined,
      is_exported: meta.isExported,
      docstring: meta.docstring,
      start_line: boundaryNode.startPosition.row + 1,
      end_line: classNode.endPosition.row + 1,
      content: skeletonContent,
      content_hash: this.generateHash(skeletonContent),
    };

    const memberChunks = directMembers.flatMap((m) =>
      this.processNode(m.node, m.symbolType, captured, sourceCode, filePath, config),
    );

    return [skeleton, ...memberChunks];
  }

  // Core size-adaptive decision for one captured root/member node: fits the
  // budget -> one whole chunk; too big and it's a class -> skeleton +
  // members; too big and it's anything else -> AST-boundary split parts.
  private processNode(
    node: any,
    symbolType: string,
    captured: Array<{ node: any; symbolType: string }>,
    sourceCode: string,
    filePath: string,
    config: LangConfig,
  ): ChunkMetadata[] {
    const symbolName = this.resolveSymbolName(node);
    const parentSymbol = this.resolveParentSymbol(node);
    const qualifiedName = parentSymbol ? `${parentSymbol}.${symbolName}` : symbolName;
    const isExported = this.resolveIsExported(node);
    const { boundaryNode, docstring } = this.resolveLeadingContext(node);

    const meta: SymbolMeta = { symbolType, symbolName, qualifiedName, parentSymbol, isExported, docstring };
    const rawSize = this.measureSize(sourceCode.slice(node.startIndex, node.endIndex));

    if (rawSize <= CHUNK_BUDGET_CHARS) {
      return [
        this.buildChunkFromRange(
          boundaryNode.startIndex,
          node.endIndex,
          sourceCode,
          filePath,
          config,
          meta,
          boundaryNode.startPosition.row + 1,
          node.endPosition.row + 1,
        ),
      ];
    }

    if (symbolType === "class") {
      const skeletonResult = this.buildClassSkeletonAndMembers(
        node,
        meta,
        boundaryNode,
        captured,
        sourceCode,
        filePath,
        config,
      );
      if (skeletonResult) return skeletonResult;
      // Fall through to the generic AST-boundary split below — no members
      // to skeletonize (e.g. a data-only struct).
    }

    const bodyNode = this.findBodyField(node);
    const statements: any[] = bodyNode?.namedChildren ?? [];
    const parts = this.buildAstAwareParts(
      statements,
      sourceCode,
      node.startIndex,
      node.endIndex,
      node.startPosition.row,
      node.endPosition.row,
    );
    // The leading comment/decorator (if any) belongs with the first part only.
    parts[0] = { ...parts[0], startIndex: boundaryNode.startIndex, startRow: boundaryNode.startPosition.row };

    if (parts.length === 1) {
      return [
        this.buildChunkFromRange(
          parts[0].startIndex,
          parts[0].endIndex,
          sourceCode,
          filePath,
          config,
          meta,
          parts[0].startRow + 1,
          parts[0].endRow + 1,
        ),
      ];
    }

    return parts.map((part, i) =>
      this.buildChunkFromRange(
        part.startIndex,
        part.endIndex,
        sourceCode,
        filePath,
        config,
        meta,
        part.startRow + 1,
        part.endRow + 1,
        { index: i + 1, total: parts.length },
      ),
    );
  }

  // Fallback: the parser succeeded but the query found nothing (script-style
  // file, config file, top-level-only code). Don't silently drop it from the
  // index — index the whole file instead of returning nothing (an empty
  // chunk array is treated by the indexer as "delete every existing row for
  // this file"). Uses the same AST-boundary packer as any oversized symbol,
  // walking the file's own top-level statements as its "body".
  private buildWholeFileFallback(sourceCode: string, filePath: string, config: LangConfig, rootNode: any): ChunkMetadata[] {
    const meta: SymbolMeta = {
      symbolType: "file",
      symbolName: path.basename(filePath),
      qualifiedName: path.basename(filePath),
      parentSymbol: null,
      isExported: false,
      docstring: null,
    };
    const totalLines = sourceCode.split("\n").length;

    if (this.measureSize(sourceCode) <= CHUNK_BUDGET_CHARS) {
      return [this.buildChunkFromRange(0, sourceCode.length, sourceCode, filePath, config, meta, 1, totalLines)];
    }

    const statements: any[] = rootNode?.namedChildren ?? [];
    const parts = this.buildAstAwareParts(
      statements,
      sourceCode,
      0,
      sourceCode.length,
      0,
      rootNode ? rootNode.endPosition.row : Math.max(totalLines - 1, 0),
    );

    if (parts.length === 1) {
      return [
        this.buildChunkFromRange(
          parts[0].startIndex,
          parts[0].endIndex,
          sourceCode,
          filePath,
          config,
          meta,
          parts[0].startRow + 1,
          parts[0].endRow + 1,
        ),
      ];
    }

    return parts.map((part, i) =>
      this.buildChunkFromRange(
        part.startIndex,
        part.endIndex,
        sourceCode,
        filePath,
        config,
        meta,
        part.startRow + 1,
        part.endRow + 1,
        { index: i + 1, total: parts.length },
      ),
    );
  }

  // Guards the UNIQUE(repository_id, file_path, content_hash) constraint —
  // the INSERT in repositoryIndex.service.ts has no ON CONFLICT clause, so
  // any collision within a file throws and rolls back the whole indexing
  // transaction. Mirrors documentationChunking.service.ts's existing,
  // already-proven pre-insert dedup for the same constraint.
  private dedupeByContentHash(chunks: ChunkMetadata[], filePath: string): ChunkMetadata[] {
    const seen = new Set<string>();
    const out: ChunkMetadata[] = [];
    for (const c of chunks) {
      if (seen.has(c.content_hash)) {
        console.warn(
          `[AST Chunker] Duplicate content_hash within ${filePath} for ${c.qualified_name ?? c.symbol_name} — skipping`,
        );
        continue;
      }
      seen.add(c.content_hash);
      out.push(c);
    }
    return out;
  }

  public async chunkFile(filePath: string, sourceCode: string): Promise<ChunkMetadata[]> {
    if (!this.isInitialized) {
      await this.init(); // Auto-initialize if forgotten
    }

    const ext = path.extname(filePath).toLowerCase();
    const config = LANGUAGE_REGISTRY[ext as keyof typeof LANGUAGE_REGISTRY];

    // Safely ignore unknown file types silently
    if (!config) return [];

    let parser: Parser | null = null;
    let tree: any = null;
    let query: Query | null = null;

    try {
      const language = await this.getLanguage(config.wasmPath);
      if (!language) return [];

      parser = new Parser();
      parser.setLanguage(language);

      tree = parser.parse(sourceCode);
      if (!tree) {
        console.warn(`[AST Chunker] Failed to build syntax tree for ${filePath}`);
        return [];
      }

      try {
        query = new Query(language, config.query);
      } catch (queryError) {
        console.error(`[AST Chunker] Invalid Tree-Sitter Query for ${ext} files:`, queryError);
        return [];
      }

      const captured = this.captureSymbols(tree.rootNode, query);

      // Roots = captured nodes not contained inside any other captured
      // node's span. Only roots are chunking entry points — a method inside
      // a class is never independently chunked here; it's only ever reached
      // via the class's own recursion (processNode -> buildClassSkeletonAndMembers),
      // which only happens when the class is too large to stay whole. This
      // is the fix for the duplication bug: today, class + every method
      // inside it are both independently captured and both independently
      // chunked, unconditionally.
      const roots = captured.filter((c) => !captured.some((o) => o !== c && this.isContained(c.node, o.node)));

      let chunks: ChunkMetadata[] = [];
      for (const root of roots) {
        try {
          chunks.push(...this.processNode(root.node, root.symbolType, captured, sourceCode, filePath, config));
        } catch (nodeError) {
          // One malformed capture shouldn't take down chunking for the whole file.
          console.error(`[AST Chunker] Failed to process a symbol in ${filePath}:`, nodeError);
        }
      }

      if (chunks.length === 0 && sourceCode.trim().length > 0) {
        chunks = this.buildWholeFileFallback(sourceCode, filePath, config, tree.rootNode);
      }

      chunks = this.dedupeByContentHash(chunks, filePath);

      console.log(`[AST Chunker] Extracted ${chunks.length} chunk(s) from ${filePath}`);
      return chunks;
    } catch (error) {
      console.error(`[AST Chunker] Unexpected error processing ${filePath}:`, error);
      return [];
    } finally {
      // Always release WASM memory, even if the parser crashes.
      if (tree) tree.delete();
      if (query) query.delete();
      if (parser) parser.delete();
    }
  }

  public async extractFileAstMetadata(
    filePath: string,
    sourceCode: string,
  ): Promise<FileASTMetadata | null> {
    if (!this.isInitialized) await this.init();

    const ext = path.extname(filePath).toLowerCase();
    const config = LANGUAGE_REGISTRY[ext as keyof typeof LANGUAGE_REGISTRY];
    if (!config) return null;

    let parser: Parser | null = null;
    let tree: any = null;
    let query: Query | null = null;

    try {
      const language = await this.getLanguage(config.wasmPath);
      if (!language) return null;

      parser = new Parser();
      parser.setLanguage(language);
      tree = parser.parse(sourceCode);
      if (!tree) return null;

      const imports = new Set<string>();
      const exports = new Set<string>();
      const decorators = new Set<string>();
      const inheritance: { child: string; parents: string[] }[] = [];

      const visit = (node: any) => {
        switch (node.type) {
          case "import_statement":
          case "import_from_statement": {
            const src = node.childForFieldName?.("source");
            imports.add(src?.text ? src.text.replace(/['"]/g, "") : node.text.split("\n")[0].trim());
            break;
          }
          case "export_statement":
            exports.add(node.text.split("\n")[0].trim());
            break;
          case "decorator":
            decorators.add(node.text.trim());
            break;
          case "class_declaration":
          case "class_specifier": {
            const nameNode = node.childForFieldName?.("name");
            const heritage = node.childForFieldName?.("superclass") ?? node.childForFieldName?.("heritage");
            if (nameNode?.text && heritage?.text) {
              inheritance.push({
                child: nameNode.text,
                parents: [heritage.text.replace(/^extends\s+/, "").trim()],
              });
            }
            break;
          }
          default:
            break;
        }
        for (const child of node.namedChildren ?? []) visit(child);
      };
      visit(tree.rootNode);

      // classes/interfaces/functions are derived independently from the
      // same capture query chunkFile() uses — NOT from chunkFile()'s
      // output, which reflects chunking decisions (skeleton-vs-whole,
      // member-or-not) that have nothing to do with "what symbols does this
      // file declare." This keeps Phase 2 summarization's ground-truth
      // inventory (summarizer.service.ts feeds these lists straight into
      // the file-summary LLM prompt) complete regardless of how large any
      // given class/function is — a large class that becomes a
      // class_skeleton chunk, or a small class's methods that never get
      // their own chunk row, must still show up here. Also removes the
      // previous double-parse (this used to call chunkFile() a second time
      // solely for this).
      let classes: string[] = [];
      let interfaces: string[] = [];
      let functions: string[] = [];
      try {
        query = new Query(language, config.query);
        const captured = this.captureSymbols(tree.rootNode, query);
        for (const { node, symbolType } of captured) {
          const symbolName = this.resolveSymbolName(node);
          if (symbolType === "class") {
            classes.push(symbolName);
          } else if (symbolType === "interface") {
            interfaces.push(symbolName);
          } else if (symbolType === "function" || symbolType === "method") {
            const parentSymbol = this.resolveParentSymbol(node);
            functions.push(parentSymbol ? `${parentSymbol}.${symbolName}` : symbolName);
          }
        }
      } catch (queryError) {
        console.error(`[AST Chunker] Invalid Tree-Sitter Query for ${ext} files:`, queryError);
      }

      return {
        filePath,
        folderPath: path.dirname(filePath),
        language: config.name,
        imports: Array.from(imports),
        exports: Array.from(exports),
        classes,
        interfaces,
        functions,
        decorators: Array.from(decorators),
        annotations: [], // reserved for languages with distinct annotation syntax (e.g. Java)
        inheritance,
        sourceHash: this.generateHash(sourceCode),
      };
    } catch (error) {
      console.error(`[AST Chunker] Failed to extract file metadata for ${filePath}:`, error);
      return null;
    } finally {
      if (tree) tree.delete();
      if (query) query.delete();
      if (parser) parser.delete();
    }
  }

}

export const astChunker = new AstChunkingService();
